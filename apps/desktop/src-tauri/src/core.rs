use serde::Serialize;
use std::{
    io::{BufRead, BufReader, Read, Write},
    os::windows::process::CommandExt,
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex, mpsc},
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const TICK: Duration = Duration::from_millis(100);
const STARTUP_TIMEOUT: Duration = Duration::from_secs(8);
const EXIT_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Clone, Serialize)]
#[serde(tag = "phase", rename_all = "snake_case")]
pub enum CoreStatus {
    Starting,
    Ready {
        port: u16,
        token: String,
        restarts: u32,
    },
    Restarting,
    Unavailable,
}

pub struct CoreSupervisor {
    status: Arc<Mutex<CoreStatus>>,
    stop: mpsc::Sender<()>,
    worker: Mutex<Option<JoinHandle<()>>>,
}

pub struct CorePaths {
    pub runtime: PathBuf,
    pub data: PathBuf,
    pub origin: &'static str,
}

impl CoreSupervisor {
    pub fn start(paths: CorePaths) -> Self {
        let status = Arc::new(Mutex::new(CoreStatus::Starting));
        let worker_status = status.clone();
        let (stop, stopped) = mpsc::channel();
        let worker = thread::spawn(move || supervise(&paths, &worker_status, &stopped));

        Self {
            status,
            stop,
            worker: Mutex::new(Some(worker)),
        }
    }

    pub fn status(&self) -> CoreStatus {
        self.status.lock().expect("内核状态锁").clone()
    }

    pub fn shutdown(&self) {
        let _ = self.stop.send(());
        if let Some(worker) = self.worker.lock().expect("内核线程锁").take() {
            let _ = worker.join();
        }
    }
}

fn supervise(paths: &CorePaths, status: &Mutex<CoreStatus>, stopped: &mpsc::Receiver<()>) {
    let mut restarts = 0_u32;
    let mut failures = 0_u32;
    loop {
        if !matches!(stopped.try_recv(), Err(mpsc::TryRecvError::Empty)) {
            return;
        }

        let mut was_ready = false;
        if let Ok((mut core, token, ready_port)) = CoreProcess::launch(paths) {
            let deadline = Instant::now() + STARTUP_TIMEOUT;
            loop {
                if !matches!(
                    stopped.recv_timeout(TICK),
                    Err(mpsc::RecvTimeoutError::Timeout)
                ) {
                    return;
                }
                if !matches!(core.child.try_wait(), Ok(None)) {
                    break;
                }
                if !was_ready {
                    match ready_port.try_recv() {
                        Ok(Some(port)) => {
                            *status.lock().expect("内核状态锁") = CoreStatus::Ready {
                                port,
                                token: token.clone(),
                                restarts,
                            };
                            was_ready = true;
                        }
                        Err(mpsc::TryRecvError::Empty) if Instant::now() < deadline => {}
                        _ => break,
                    }
                }
            }
        }

        *status.lock().expect("内核状态锁") = if was_ready {
            failures = 0;
            CoreStatus::Restarting
        } else {
            failures = failures.saturating_add(1);
            CoreStatus::Unavailable
        };
        restarts = restarts.saturating_add(1);

        let delay = Duration::from_millis(500 << failures.min(3));
        if !matches!(
            stopped.recv_timeout(delay),
            Err(mpsc::RecvTimeoutError::Timeout)
        ) {
            return;
        }
    }
}

struct CoreProcess {
    child: Child,
}

impl CoreProcess {
    fn launch(paths: &CorePaths) -> Result<(Self, String, mpsc::Receiver<Option<u16>>), ()> {
        let mut random = [0u8; 32];
        getrandom::fill(&mut random).map_err(|_| ())?;
        let token: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
        let config = serde_json::json!({
            "token": token,
            "dataDir": paths.data,
            "origin": paths.origin
        });

        let mut core = Self {
            child: Command::new(paths.runtime.join("node.exe"))
                .arg(paths.runtime.join("core.cjs"))
                .current_dir(&paths.runtime)
                .env_remove("NODE_OPTIONS")
                .env_remove("NODE_PATH")
                .env_remove("NODE_DEBUG")
                .env_remove("NODE_DEBUG_NATIVE")
                .env_remove("SSLKEYLOGFILE")
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .creation_flags(CREATE_NO_WINDOW)
                .spawn()
                .map_err(|_| ())?,
        };

        let output = core.child.stdout.take().ok_or(())?;
        let input = core.child.stdin.as_mut().ok_or(())?;
        writeln!(input, "{config}").map_err(|_| ())?;

        let (ready, receive) = mpsc::channel();
        thread::spawn(move || {
            #[derive(serde::Deserialize)]
            struct Ready {
                port: u16,
            }

            let mut line = String::new();
            let port = BufReader::new(output.take(128))
                .read_line(&mut line)
                .ok()
                .filter(|_| line.ends_with('\n'))
                .and_then(|_| serde_json::from_str::<Ready>(&line).ok())
                .map(|message| message.port)
                .filter(|port| *port != 0);
            let _ = ready.send(port);
        });

        Ok((core, token, receive))
    }
}

impl Drop for CoreProcess {
    fn drop(&mut self) {
        // 关闭输入管道让内核结束监听。外壳被强制结束时，管道同样会关闭。
        drop(self.child.stdin.take());
        let deadline = Instant::now() + EXIT_TIMEOUT;
        while matches!(self.child.try_wait(), Ok(None)) && Instant::now() < deadline {
            thread::sleep(TICK);
        }
        if !matches!(self.child.try_wait(), Ok(Some(_))) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpStream;

    #[test]
    fn shutdown_stops_ready_core_without_relaunching() {
        let runtime = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("build/runtime");
        assert!(runtime.join("node.exe").is_file(), "先运行 prepare:runtime");
        let supervisor = CoreSupervisor::start(CorePaths {
            runtime,
            data: std::env::temp_dir().join("paihuo-test"),
            origin: "http://tauri.localhost",
        });
        let deadline = Instant::now() + STARTUP_TIMEOUT;
        let port = loop {
            if let CoreStatus::Ready { port, .. } = supervisor.status() {
                break port;
            }
            assert!(Instant::now() < deadline, "等待内核就绪超时");
            thread::sleep(TICK);
        };
        assert!(TcpStream::connect(("127.0.0.1", port)).is_ok());

        let (done, finished) = mpsc::channel();
        let test = thread::spawn(move || {
            supervisor.shutdown();
            let _ = done.send(());
        });
        finished
            .recv_timeout(EXIT_TIMEOUT + Duration::from_secs(1))
            .expect("关闭守护线程超时");
        test.join().unwrap();
        assert!(
            TcpStream::connect(("127.0.0.1", port)).is_err(),
            "停止内核后端口仍可连接",
        );
    }
}
