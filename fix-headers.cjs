const fs = require('fs');

const dContent = fs.readFileSync('app/routes/api.free-sample.dashboard.tsx', 'utf8');
const kContent = fs.readFileSync('app/routes/api.free-sample.kitten.tsx', 'utf8');

// Extract the dashboard header
const dHeaderMatch = dContent.match(/<div class="pk-dashboard-header">[\s\S]*?<\/div>\s*<\/div>/);
const dHeader = dHeaderMatch ? dHeaderMatch[0] : '';

// Extract the pet selector row
const kPetSelectorMatch = kContent.match(/<!-- PET SELECTOR HEADER -->[\s\S]*?<div class="pk-pet-selector-row">[\s\S]*?<[^>]*class="pk-pet-add-btn"[^>]*>\+ Add Kitten<\/[a-z]+>\s*<\/div>/i);
const kPetSelector = kPetSelectorMatch ? kPetSelectorMatch[0] : '';

// Create the unified pet selector with absolute paths
const unifiedPetSelector = kPetSelector.replace(/href="\?pet_index=/g, 'href="/apps/purrkins/kitten?pet_index=');

// Now we need to modify dashboard.tsx: insert unifiedPetSelector AFTER the dashboard header
let newDContent = dContent.replace(dHeader, dHeader + '\n\n      ' + unifiedPetSelector);

// We need to initialize active_index as -1 in dashboard so no pet is active
newDContent = newDContent.replace(
  '<div class="pk-dashboard-wrapper">',
  '{% assign pets = customer.metafields.custom.pets.value %}\n    {% assign active_index = -1 %}\n    <div class="pk-dashboard-wrapper">'
);

// Now we need to modify kitten.tsx: insert dHeader BEFORE the pet selector
let newKContent = kContent.replace(kPetSelectorMatch[0], dHeader + '\n\n      ' + unifiedPetSelector);

// Update the PJAX script in both files to intercept .pk-pet-pill
const pjaxRegex = /var link = e\.target\.closest\("a\.pk-menu-item"\);/;
const newPjaxLine = 'var link = e.target.closest("a.pk-menu-item, a.pk-pet-pill");';
newDContent = newDContent.replace(pjaxRegex, newPjaxLine);
newKContent = newKContent.replace(pjaxRegex, newPjaxLine);

fs.writeFileSync('app/routes/api.free-sample.dashboard.tsx', newDContent);
fs.writeFileSync('app/routes/api.free-sample.kitten.tsx', newKContent);

console.log('Successfully injected headers and pet selectors to both files');
