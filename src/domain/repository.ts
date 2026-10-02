/* 存储层契约（domain 侧定义，infrastructure 实现——依赖倒置）。
   泛型 T 由 KeyRegistry 中的 KeyDefinition<T> 绑定，确保每个 key 的读写类型唯一。 */

export interface IRepository<T> {
  /** 读取反序列化数据；无数据/解析失败/结构不符时回退注册的 fallback */
  read(): T;
  /** 序列化写入；失败（如隐私模式配额）返回 false */
  write(value: T): boolean;
  remove(): void;
}
