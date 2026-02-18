const fs = require('fs');
const data = JSON.parse(fs.readFileSync('data/zer4u-schema-analysis.json', 'utf8'));
data.forEach((item, i) => {
  console.log((i+1) + '. ' + item.fileName + ' -> ' + item.tableName);
});
