// 仅供源码开发：新线程显式注册 TS 加载器，不继承宿主的测试/加载器参数。
import { register } from "tsx/esm/api";
register();
await import("./render-thread.ts");
