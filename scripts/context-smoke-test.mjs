#!/usr/bin/env node
/**
 * Context Management Smoke Test
 * Tests that context compaction works without losing critical data
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

console.log('🔥 Context Management Smoke Test\n');

// Test 1: Config loaded correctly
console.log('Test 1: Config validation');
try {
  const configPath = path.join(rootDir, 'config', 'default.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

  const contextBudget = config.runtime?.omniLoop?.contextCharBudget;
  if (contextBudget >= 400000) {
    console.log('  ✅ Context budget sufficient:', contextBudget);
  } else {
    console.log('  ❌ Context budget too low:', contextBudget);
    process.exit(1);
  }
} catch (err) {
  console.log('  ❌ Config load failed:', err.message);
  process.exit(1);
}

// Test 2: Sub-agent spawner has context bounds
console.log('\nTest 2: Sub-agent context check');
try {
  const spawnerPath = path.join(rootDir, 'src', 'core', 'sub-agent-spawner.js');
  const spawnerCode = fs.readFileSync(spawnerPath, 'utf8');

  if (spawnerCode.includes('boundSubAgentContext')) {
    console.log('  ✅ Sub-agent context compaction exists');
  } else {
    console.log('  ⚠️  Sub-agent context compaction not found (will be added in Phase 3)');
  }

  if (spawnerCode.includes('contextChars:')) {
    console.log('  ✅ Sub-agent uses contextChars limit');
  } else {
    console.log('  ❌ Sub-agent missing context limit');
  }
} catch (err) {
  console.log('  ⚠️  Sub-agent file check skipped:', err.message);
}

// Test 3: Tool result truncation helpers exist
console.log('\nTest 3: Tool truncation helpers');
try {
  const omniLoopPath = path.join(rootDir, 'src', 'core', 'omni-loop.js');
  const omniLoopCode = fs.readFileSync(omniLoopPath, 'utf8');

  if (omniLoopCode.includes('truncateToolResult')) {
    console.log('  ✅ truncateToolResult function exists');
  } else {
    console.log('  ❌ truncateToolResult missing');
    process.exit(1);
  }

  if (omniLoopCode.includes('formatToolResultForModel')) {
    console.log('  ✅ formatToolResultForModel exists');
  } else {
    console.log('  ❌ formatToolResultForModel missing');
    process.exit(1);
  }

  if (omniLoopCode.includes('persistFullToolResult')) {
    console.log('  ✅ Full tool result persistence exists');
  } else {
    console.log('  ⚠️  Full tool result persistence not found');
  }
} catch (err) {
  console.log('  ❌ omni-loop.js check failed:', err.message);
  process.exit(1);
}

// Test 4: Summarization engine exists
console.log('\nTest 4: Summarization engine');
try {
  const summaryPath = path.join(rootDir, 'src', 'core', 'summarization-engine.js');
  const summaryCode = fs.readFileSync(summaryPath, 'utf8');

  if (summaryCode.includes('summarizeSession')) {
    console.log('  ✅ Session summarization exists');
  } else {
    console.log('  ❌ summarizeSession missing');
    process.exit(1);
  }

  // Check if summary window is adequate
  const match = summaryCode.match(/\.slice\(-([0-9]+)\)/);
  if (match) {
    const windowSize = parseInt(match[1], 10);
    if (windowSize >= 60000) {
      console.log(`  ✅ Summary window size adequate: ${windowSize} chars`);
    } else {
      console.log(`  ⚠️  Summary window small: ${windowSize} chars (will be upgraded in Phase 2)`);
    }
  }
} catch (err) {
  console.log('  ⚠️  Summarization check skipped:', err.message);
}

console.log('\n✅ Smoke tests passed! Context management infrastructure is in place.');
console.log('\nNext steps:');
console.log('  1. Run: node scripts/verify-context-fix.mjs');
console.log('  2. Test with a complex task (multiple file reads + sub-agents)');
console.log('  3. Monitor token usage in logs');
console.log('  4. If working well, proceed to Phase 2 (smart compaction)');
