import fs from "node:fs";
import path from "node:path";

const dirsToClean = ["dist"];

// Clean directories
for (const dir of dirsToClean) {
  const fullPath = path.resolve(process.cwd(), dir);
  if (fs.existsSync(fullPath)) {
    fs.rmSync(fullPath, { recursive: true, force: true });
    console.log(`Cleaned directory: ${dir}`);
  }
}

// Clean .tsbuildinfo files
const files = fs.readdirSync(process.cwd());
for (const file of files) {
  if (file.endsWith(".tsbuildinfo")) {
    const fullPath = path.resolve(process.cwd(), file);
    fs.rmSync(fullPath, { force: true });
    console.log(`Cleaned file: ${file}`);
  }
}
