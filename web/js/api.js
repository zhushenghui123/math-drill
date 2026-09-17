// web/js/api.js —— 唯一存储桥 + judge 客户端（45 个 save() 调用点不动，全部经此收敛）
//
// 预留窗口（题库，Phase 3）：本文件是**唯一**允许发起 HTTP 的地方。
// 未来题库调用在此加薄封装，形如：
//   qbank.list({type, difficulty, done})  → GET /m/qbank/list
//   qbank.detail(qid)                     → GET /m/qbank/detail
// 纪律：不得新增第二个端口 / 第二个网关（ARCHITECTURE §11.5）。
