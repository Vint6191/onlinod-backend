"use strict";
const test=require('node:test'),assert=require('node:assert/strict');
const {hourlyPoints}=require('./earnings-published-snapshot');
const day=new Date('2026-10-15');
test('hourly evidence must exactly match the verified single-day total',()=>{
  const good={summary:{totalCents:2400},hourlyPoints:[{label:'2026-10-15T10:00:00.000Z',valueCents:900},{label:'2026-10-15T20:00:00.000Z',valueCents:1500}]};
  assert.deepEqual(hourlyPoints(good,day,day),good.hourlyPoints);
  assert.equal(hourlyPoints({},day,day),null);
  for(const changed of [
    {...good,summary:{totalCents:2401}},
    {...good,hourlyPoints:[...good.hourlyPoints].reverse()},
    {...good,hourlyPoints:[good.hourlyPoints[0],good.hourlyPoints[0]]},
    {...good,hourlyPoints:[{label:'2026-10-14T10:00:00.000Z',valueCents:2400}]},
    {...good,hourlyPoints:[{label:'2026-10-15T10:00:00.000Z',valueCents:-1}]},
  ]) assert.throws(()=>hourlyPoints(changed,day,day),/EARNINGS_HOURLY/);
  assert.throws(()=>hourlyPoints(good,new Date('2026-10-14'),day),/EARNINGS_HOURLY/);
});
