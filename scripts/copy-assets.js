import fs from 'fs';

// Clean dist/templates to remove stale files from renamed/deleted templates
fs.rmSync('dist/templates', { recursive: true, force: true });

// Copy public assets (built UI)
fs.cpSync('public', 'dist/public', { recursive: true });

// Copy templates (skip hidden files except .env.example)
fs.cpSync('templates', 'dist/templates', {
  recursive: true,
  filter: (s) => !s.split('/').some(p => p.startsWith('.') && p !== '.' && p !== '.env.example'),
});
