'use strict';
process.env.TZ='UTC';
const {fixture: currentFixture,scope}=require('../analytics-traffic/fixture.cjs');
async function fixture(){
 const f=await currentFixture();
 require.cache[require.resolve('../../../src/prisma')]={exports:f.db};
 return f;
}
module.exports={fixture,scope};
