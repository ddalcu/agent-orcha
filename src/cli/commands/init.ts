import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function directoryExists(dirPath: string): Promise<boolean> {
  try {
    const stats = await fs.stat(dirPath);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function copyTemplates(targetDir: string): Promise<void> {
  // When built, this file is at dist/src/cli/commands/init.js
  // Templates are copied to dist/templates during build
  // So we need to go up 3 levels: dist/src/cli/commands -> dist
  const templatesDir = path.resolve(__dirname, '../../../templates');

  // Check if templates directory exists
  if (!(await directoryExists(templatesDir))) {
    throw new Error('Templates directory not found. Please ensure the package is properly installed.');
  }

  // Copy all template directories
  const templateDirs = ['agents', 'functions', 'knowledge', 'skills', 'workflows'];

  for (const dir of templateDirs) {
    const sourcePath = path.join(templatesDir, dir);
    const targetPath = path.join(targetDir, dir);

    if (await directoryExists(sourcePath)) {
      await fs.cp(sourcePath, targetPath, { recursive: true });
      console.log(`✓ Created ${dir}/ directory with examples`);
    }
  }

  // Copy config files
  const configFiles = ['mcp.json', 'llm.json', 'llm.md', '.env.example', 'README.md'];

  for (const file of configFiles) {
    const sourcePath = path.join(templatesDir, file);
    const targetPath = path.join(targetDir, file);

    if (await fileExists(sourcePath)) {
      await fs.copyFile(sourcePath, targetPath);
      console.log(`✓ Created ${file}`);
    }
  }
}

export async function initCommand(args: string[]): Promise<void> {
  const targetDir = args[0] ?? process.cwd();
  const isCurrentDir = targetDir === '.' || targetDir === process.cwd();

  console.log('\nAgent Orcha - Project Initialization\n');

  // Check if target directory exists or create it
  if (!isCurrentDir) {
    if (await directoryExists(targetDir)) {
      console.error(`Error: Directory "${targetDir}" already exists.`);
      console.error('Please choose a different directory or run "npx agent-orcha init" in an empty directory.');
      process.exit(1);
    }
    await fs.mkdir(targetDir, { recursive: true });
    console.log(`✓ Created project directory: ${targetDir}\n`);
  } else {
    // Check if current directory is empty
    const files = await fs.readdir(targetDir);
    const hasContent = files.some(f =>
      !f.startsWith('.') && f !== 'node_modules' && f !== 'package.json' && f !== 'package-lock.json'
    );

    if (hasContent) {
      console.log('Warning: Current directory is not empty.');
      console.log('Existing files will not be overwritten.\n');
    }
  }

  // Check if directories already exist
  const dirs = ['agents', 'functions', 'knowledge', 'skills', 'workflows'];
  const existingDirs = [];

  for (const dir of dirs) {
    if (await directoryExists(path.join(targetDir, dir))) {
      existingDirs.push(dir);
    }
  }

  if (existingDirs.length > 0) {
    console.error(`Error: The following directories already exist: ${existingDirs.join(', ')}`);
    console.error('This appears to be an existing Agent Orcha project.');
    process.exit(1);
  }

  // Copy templates
  try {
    await copyTemplates(targetDir);
  } catch (error) {
    console.error('Error copying templates:', error);
    process.exit(1);
  }

  console.log('\n✓ Project initialized successfully!\n');
  console.log('Next steps:');
  if (!isCurrentDir) {
    console.log(`  1. cd ${targetDir}`);
  }
  console.log(`  ${isCurrentDir ? '1' : '2'}. Configure llm.json with your LLM settings`);
  console.log(`  ${isCurrentDir ? '2' : '3'}. Configure mcp.json for MCP servers (optional)`);
  console.log(`  ${isCurrentDir ? '3' : '4'}. Copy .env.example to .env and configure (optional)`);
  console.log(`  ${isCurrentDir ? '4' : '5'}. Run: npx agent-orcha start\n`);
  console.log('Documentation: https://github.com/ddalcu/agent-orcha\n');
}
