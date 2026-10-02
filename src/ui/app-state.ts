/* UI 视图状态类型：表单草稿与查询/仿真面板的跨渲染状态（教训 #23：恢复旧选中值时须绑定实体身份）。 */

import type { SimulationSummary } from '../application/simulation-service';

/** 线路表单草稿（含大站标记） */
export interface LineDraft {
  stationSeq: string[];
  majorNos: string[];
}

/** 车次表单草稿站序 */
export interface TrainDraft {
  stationSeq: string[];
}

/** 数据查询区状态：segIdx 仅在 segTrainCode 未变时恢复，避免跨车次段选择错位 */
export interface QueryState {
  trainCode: string;
  segIdx: number;
  segTrainCode: string;
}

/** 仿真摘要（含线路大站集合标注），切页签不丢 */
export interface SimSummaryState extends SimulationSummary {
  summaryLineMajorNos: string[];
}
