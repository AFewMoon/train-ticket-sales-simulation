/* 持久化专用形状：候补队列文件与号码池。
   队列现结构为单条有序列表 { trains: { [trainCode]: Entry[] } }；
   旧版 { buckets: [...] } 结构在 scanAllTrains 对账时探测并废弃重建（教训 #16）。 */

/** 候补队列条目（订单进入候补时的快照） */
export interface QueueEntry {
  id: string;
  fromIdx: number;
  toIdx: number;
  createdAt: number;
}

/** 候补队列持久化文件：按车次分组、组内按 createdAt 升序 */
export interface QueueFile {
  trains: Record<string, QueueEntry[]>;
}

/** 唯一号码池：已分配过的车站号码与车次号（含已删除实体的号码，避免复用） */
export interface SeqPool {
  stationNos: string[];
  trainCodes: string[];
}
