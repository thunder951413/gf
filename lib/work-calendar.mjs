// 2026 official public calendar. Unknown years use weekdays/weekends only.
// Source: https://www.beijing.gov.cn/fuwu/bmfw/sy/jrts/202511/t20251104_4258838.html
const HOLIDAYS_2026=[['元旦','01-01','01-03'],['春节','02-15','02-23'],['清明','04-04','04-06'],['劳动节','05-01','05-05'],['端午','06-19','06-21'],['中秋','09-25','09-27'],['国庆','10-01','10-07']];
const WORKDAYS_2026=new Set(['01-04','02-14','02-28','05-09','09-20','10-10']);
export function workCalendar(at){
  const local=new Date(+new Date(at)+8*3600000),day=local.toISOString().slice(0,10),suffix=day.slice(5),weekend=[0,6].includes(local.getUTCDay());
  const known=day.startsWith('2026-'),holiday=known?HOLIDAYS_2026.find(([,start,end])=>suffix>=start&&suffix<=end):null;
  return {day,weekday:'周'+'日一二三四五六'[local.getUTCDay()],holiday:holiday?.[0]||null,restDay:holiday?true:known&&WORKDAYS_2026.has(suffix)?false:weekend,source:known?'2026官方假期安排':'周末基础日历'};
}
