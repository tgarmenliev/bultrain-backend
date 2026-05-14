const fs = require('fs');
const path = require('path');

const dirPath = path.join(__dirname, 'stations_trains', 'raw_bdz_data');

function fixTrainNumbers() {
  if (!fs.existsSync(dirPath)) {
    console.error(`Directory not found: ${dirPath}`);
    return;
  }

  console.log(`Reading directory: ${dirPath}`);
  const files = fs.readdirSync(dirPath)
    .filter(file => file.endsWith('.json'))
    .map(file => {
      const filePath = path.join(dirPath, file);
      const stats = fs.statSync(filePath);
      // Use mtime for "last created/modified"
      return { file, filePath, time: stats.mtime.getTime() };
    })
    .sort((a, b) => b.time - a.time); // Newest first

  console.log(`Found ${files.length} JSON files. Processing...`);

  let updatedCount = 0;
  let processedCount = 0;

  files.forEach(({ file, filePath }) => {
    // Extract train number from filename (e.g., 909620 from 909620_sat.json)
    const match = file.match(/^(\d+)_/);
    if (!match) return;

    const fileTrainNumber = match[1];

    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const data = JSON.parse(content);
      processedCount++;

      if (data.trainNumber !== fileTrainNumber) {
        console.log(`[Update] ${file}: JSON "${data.trainNumber}" -> Filename "${fileTrainNumber}"`);
        data.trainNumber = fileTrainNumber;
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
        updatedCount++;
      }
    } catch (err) {
      console.error(`Error processing file ${file}:`, err.message);
    }
  });

  console.log(`\nProcessing complete.`);
  console.log(`Total files checked: ${processedCount}`);
  console.log(`Total files updated: ${updatedCount}`);
}

fixTrainNumbers();
