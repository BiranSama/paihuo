import type { RuntimeKind, StaffAdapter } from "@paihuo/shared/staff";

export class AdapterRegistry {
  private readonly adapters = new Map<RuntimeKind, StaffAdapter>();

  constructor(adapters: readonly StaffAdapter[] = []) {
    for (const adapter of adapters) this.register(adapter);
  }

  register(adapter: StaffAdapter) {
    if (this.adapters.has(adapter.kind)) throw new Error("该运行时已注册适配器");
    this.adapters.set(adapter.kind, adapter);
  }

  get(kind: RuntimeKind): StaffAdapter {
    const adapter = this.adapters.get(kind);
    if (!adapter) throw new Error("成员的运行时尚未注册");
    return adapter;
  }
}
