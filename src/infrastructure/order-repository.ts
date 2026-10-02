/* 订单仓库：在泛型存储（OrderDto[]）之上做 Order 实体 ↔ DTO 的集中映射，
   令上层只接触 Order 实体（含状态迁移行为），序列化细节不出基础设施层。 */

import { Order, type OrderDto } from '../domain/model/order';
import type { IRepository } from '../domain/repository';

export class OrderRepository implements IRepository<Order[]> {
  constructor(private readonly inner: IRepository<OrderDto[]>) {}

  read(): Order[] {
    return this.inner.read().map(Order.fromDto);
  }

  write(value: Order[]): boolean {
    return this.inner.write(value.map((o) => o.toDto()));
  }

  remove(): void {
    this.inner.remove();
  }
}
