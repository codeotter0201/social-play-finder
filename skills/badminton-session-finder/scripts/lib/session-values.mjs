export function durationMinutes(schedule) {
  const {start_time:start, end_time:end, end_day_offset:offset} = schedule;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(start ?? '') || !/^([01]\d|2[0-3]):[0-5]\d$/.test(end ?? '') || ![0,1,'0','1'].includes(offset)) return null;
  const minutes = time => Number(time.slice(0,2))*60 + Number(time.slice(3));
  const duration = minutes(end) + Number(offset)*1440 - minutes(start);
  return duration > 0 && duration <= 1440 ? duration : null;
}
export function durationLabel(schedule) {
  const minutes = durationMinutes(schedule);
  return minutes === null ? '未標示' : `${Number((minutes/60).toFixed(2))} HR`;
}
export function hourlyPrice(listing) {
  const options = (listing.price_options ?? []).filter(option => Number.isFinite(option.amount) && option.amount >= 0);
  if (!options.length) return null;
  const minimum = Math.min(...options.map(option => option.amount));
  const rates = options.filter(option => option.amount === minimum).flatMap(option => {
    const duration = option.duration_minutes == null ? durationMinutes(listing.schedule) : option.duration_minutes;
    return Number.isFinite(duration) && duration > 0 && duration <= 1440 ? [option.amount*60/duration] : [];
  });
  return rates.length ? Math.min(...rates) : null;
}
export function hourlyPriceLabel(listing) {
  const rate = hourlyPrice(listing);
  return rate === null ? "" : new Intl.NumberFormat("zh-TW", {maximumFractionDigits:2}).format(rate) + "/hr";
}
