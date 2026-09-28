const fs = require('fs');

['app/routes/api.free-sample.dashboard.tsx', 'app/routes/api.free-sample.kitten.tsx'].forEach(file => {
  let content = fs.readFileSync(file, 'utf8');
  
  // Replace the target selector for PJAX
  content = content.replace(
    'var mainContent = document.querySelector(".pk-dashboard-content");',
    'var mainContent = document.querySelector(".pk-dashboard-wrapper");'
  );
  
  content = content.replace(
    'var newContent = doc.querySelector(".pk-dashboard-content");',
    'var newContent = doc.querySelector(".pk-dashboard-wrapper");'
  );
  
  fs.writeFileSync(file, content);
});
console.log("Replaced PJAX selectors");
