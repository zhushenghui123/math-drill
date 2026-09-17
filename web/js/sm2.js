/* SM-2 间隔重复调度器（零依赖，随文档 8.4.3 的降级方案实现）
 * rating 档位：1=Again(忘了) 2=Hard(困难) 3=Good(记得) 4=Easy(简单)
 * SM-2 quality 0~5：Again->1/2, Hard->3, Good->4, Easy->5
 */
window.SM2 = (function () {
  function fmt(d) {
    var y = d.getFullYear(), m = ('0' + (d.getMonth() + 1)).slice(-2), dd = ('0' + d.getDate()).slice(-2);
    return y + '-' + m + '-' + dd;
  }
  function addDays(base, n) {
    var d = new Date(base.getFullYear(), base.getMonth(), base.getDate());
    d.setDate(d.getDate() + n);
    return d;
  }
  // 新建卡片：今天学完，明天第一轮复习
  function newCard(knowledgeId, questionId, cardType) {
    return {
      id: 'card_' + Date.now().toString(36) + '_' + Math.floor(Math.random() * 1e6).toString(36),
      type: cardType || 'knowledge',
      knowledgeId: knowledgeId || null,
      questionId: questionId || null,
      ef: 2.5, interval: 0, reps: 0, lapses: 0,
      due: fmt(addDays(new Date(), 1)),
      lastReview: null,
      createdAt: fmt(new Date())
    };
  }
  // quality: 3 分以上算记住
  function grade(card, rating) {
    var quality = rating <= 1 ? 1 : rating === 2 ? 3 : rating === 3 ? 4 : 5;
    var c = {
      ef: card.ef != null ? card.ef : 2.5,
      interval: card.interval || 0,
      reps: card.reps || 0,
      lapses: card.lapses || 0
    };
    if (quality >= 3) {
      c.interval = c.reps === 0 ? 1 : c.reps === 1 ? 6 : Math.max(1, Math.round(c.interval * c.ef));
      c.reps += 1;
    } else {
      c.reps = 0; c.interval = 1; c.lapses += 1;
    }
    c.ef = Math.max(1.3, c.ef + 0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02));
    return {
      ef: c.ef, interval: c.interval, reps: c.reps, lapses: c.lapses,
      due: fmt(addDays(new Date(), c.interval)),
      lastReview: fmt(new Date())
    };
  }
  return { newCard: newCard, grade: grade, addDays: addDays, fmt: fmt };
})();