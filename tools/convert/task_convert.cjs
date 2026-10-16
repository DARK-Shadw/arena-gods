// node tools/convert/run.cjs tools/convert/task_convert.cjs [ids...]
module.exports = async (page) => {
  const all = ['gorak', 'aldric', 'ozrel', 'erika', 'vex', 'fenrik', 'maw', 'hollowjack'];
  const ids = process.env.IDS ? process.env.IDS.split(',') : all;
  for (const id of ids) {
    const r = await page.evaluate((id) => window.convertFighter(id), id);
    console.log('[done]', JSON.stringify(r));
  }
};
