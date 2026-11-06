const fs = require('node:fs');
const path = require('node:path');

const coveragePath = path.join(__dirname, '..', 'coverage', 'coverage-final.json');
const coverage = JSON.parse(fs.readFileSync(coveragePath, 'utf8'));

const targets = [
  {
    fileSuffix: path.join('src', 'shops', 'shops.service.ts'),
    signature: 'async updateShop(',
    name: 'ShopsService.updateShop',
  },
  {
    fileSuffix: path.join('src', 'orders', 'orders.service.ts'),
    signature: 'private calculatePrice(',
    name: 'OrdersService.calculatePrice',
  },
];

function summarize(target) {
  const [filePath, fileCoverage] = Object.entries(coverage).find(([candidate]) =>
    candidate.endsWith(target.fileSuffix),
  ) ?? [];
  if (!fileCoverage) throw new Error(`Coverage data missing for ${target.fileSuffix}`);

  const source = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  const declarationLine = source.findIndex((line) => line.includes(target.signature)) + 1;
  if (!declarationLine) throw new Error(`Source declaration not found for ${target.name}`);

  const fn = Object.entries(fileCoverage.fnMap).find(([, entry]) =>
    entry.decl.start.line === declarationLine,
  );
  if (!fn) throw new Error(`Function map not found for ${target.name}`);
  const start = fn[1].loc.start.line;
  const end = fn[1].loc.end.line;

  const statements = Object.entries(fileCoverage.statementMap).filter(([, entry]) =>
    entry.start.line >= start && entry.start.line <= end,
  );
  const coveredStatements = statements.filter(([id]) => fileCoverage.s[id] > 0).length;

  const ifBranches = Object.entries(fileCoverage.branchMap).filter(([, entry]) =>
    entry.type === 'if' && entry.loc.start.line >= start && entry.loc.start.line <= end,
  );
  const totalIfArms = ifBranches.reduce((total, [, entry]) => total + entry.locations.length, 0);
  const coveredIfArms = ifBranches.reduce((total, [id, entry]) =>
    total + fileCoverage.b[id].filter((hits) => hits > 0).length, 0);

  return {
    name: target.name,
    start,
    end,
    coveredStatements,
    totalStatements: statements.length,
    coveredIfArms,
    totalIfArms,
  };
}

const results = targets.map(summarize);
console.log('Focused coverage for functions in the test document');
console.log('Scope: statement sites and explicit if true/false arms within each method.');
console.log('');
console.log('Function                         Statements            If branches');
for (const row of results) {
  const stmtPct = (100 * row.coveredStatements / row.totalStatements).toFixed(2);
  const ifPct = (100 * row.coveredIfArms / row.totalIfArms).toFixed(2);
  console.log(`${row.name.padEnd(32)} ${String(row.coveredStatements).padStart(2)}/${String(row.totalStatements).padEnd(2)} (${stmtPct}%)     ${String(row.coveredIfArms).padStart(2)}/${String(row.totalIfArms).padEnd(2)} (${ifPct}%)`);
}
