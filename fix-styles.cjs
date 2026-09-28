const fs = require('fs');
let content = fs.readFileSync('app/routes/api.free-sample.kitten.tsx', 'utf8');

// Find the first style block (starts around line 11)
const styleStart = content.indexOf('<style>');
const styleEnd = content.indexOf('</style>') + 8;
const styleBlock = content.substring(styleStart, styleEnd);

// Remove it
content = content.replace(styleBlock, '');

// Insert it into pk-dashboard-content
const target = '<div class="pk-dashboard-content">';
content = content.replace(target, target + '\n' + styleBlock);

fs.writeFileSync('app/routes/api.free-sample.kitten.tsx', content);

// Do the same for dashboard.tsx
let dContent = fs.readFileSync('app/routes/api.free-sample.dashboard.tsx', 'utf8');
const dStyleStart = dContent.indexOf('<style>');
const dStyleEnd = dContent.indexOf('</style>') + 8;
if (dStyleStart > -1) {
    const dStyleBlock = dContent.substring(dStyleStart, dStyleEnd);
    dContent = dContent.replace(dStyleBlock, '');
    dContent = dContent.replace(target, target + '\n' + dStyleBlock);
    fs.writeFileSync('app/routes/api.free-sample.dashboard.tsx', dContent);
}
console.log("Done");
