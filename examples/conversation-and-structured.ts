/**
 * Example: Conversation Memory and Structured Output
 *
 * This example demonstrates:
 * 1. Using conversation memory for multi-turn dialogues
 * 2. Getting structured JSON output from agents
 */

import { Orchestrator } from '../lib/index.js';

async function main() {
  // Initialize orchestrator
  const orchestrator = new Orchestrator({
    projectRoot: process.cwd(),
  });

  await orchestrator.initialize();

  console.log('🤖 Agent Orcha - Conversation Memory & Structured Output Example\n');

  // ========================================
  // Example 1: Conversation Memory
  // ========================================
  console.log('📝 Example 1: Conversation Memory');
  console.log('=================================\n');

  const sessionId = `demo-${Date.now()}`;

  // First message
  console.log('👤 User: Hello! My name is Alice and I work at OpenAI.');
  const response1 = await orchestrator.runAgent(
    'chatbot-memory',
    { message: 'Hello! My name is Alice and I work at OpenAI.' },
    sessionId
  );
  console.log(`🤖 Agent: ${response1.output}`);
  console.log(`   📊 Session: ${response1.metadata.sessionId}, Messages: ${response1.metadata.messagesInSession}\n`);

  // Second message - agent should remember the name and company
  console.log('👤 User: What is my name and where do I work?');
  const response2 = await orchestrator.runAgent(
    'chatbot-memory',
    { message: 'What is my name and where do I work?' },
    sessionId
  );
  console.log(`🤖 Agent: ${response2.output}`);
  console.log(`   📊 Session: ${response2.metadata.sessionId}, Messages: ${response2.metadata.messagesInSession}\n`);

  // Third message - continue conversation
  console.log('👤 User: What are my favorite hobbies? (I haven\'t told you yet)');
  const response3 = await orchestrator.runAgent(
    'chatbot-memory',
    { message: "What are my favorite hobbies?" },
    sessionId
  );
  console.log(`🤖 Agent: ${response3.output}`);
  console.log(`   📊 Session: ${response3.metadata.sessionId}, Messages: ${response3.metadata.messagesInSession}\n`);

  // Check session stats
  console.log('📊 Session Statistics:');
  console.log(`   Total Sessions: ${orchestrator.memory.getSessionCount()}`);
  console.log(`   Has Session "${sessionId}": ${orchestrator.memory.hasSession(sessionId)}`);
  console.log(`   Messages in Session: ${orchestrator.memory.getMessageCount(sessionId)}\n`);

  // ========================================
  // Example 2: Structured Output
  // ========================================
  console.log('📊 Example 2: Structured Output');
  console.log('===============================\n');

  // Sentiment analysis with structured output
  console.log('Analyzing sentiment: "I absolutely love this product! It works great!"');
  const sentimentResult = await orchestrator.runAgent(
    'sentiment-structured',
    { text: 'I absolutely love this product! It works great!' }
  );

  console.log('Response:');
  console.log(JSON.stringify(sentimentResult.output, null, 2));
  console.log(`\n✅ Structured Output Valid: ${sentimentResult.metadata.structuredOutputValid}`);
  console.log(`   Duration: ${sentimentResult.metadata.duration}ms\n`);

  // Data extraction with structured output
  console.log('Extracting entities from: "Apple CEO Tim Cook announced new features in Cupertino on January 15th, 2024."');
  const extractionResult = await orchestrator.runAgent(
    'data-extractor',
    { text: 'Apple CEO Tim Cook announced new features in Cupertino on January 15th, 2024.' }
  );

  console.log('Response:');
  console.log(JSON.stringify(extractionResult.output, null, 2));
  console.log(`\n✅ Structured Output Valid: ${extractionResult.metadata.structuredOutputValid}`);
  console.log(`   Duration: ${extractionResult.metadata.duration}ms\n`);

  // ========================================
  // Cleanup
  // ========================================
  console.log('🧹 Cleanup');
  console.log('=========\n');

  orchestrator.memory.clearSession(sessionId);
  console.log(`✅ Cleared session: ${sessionId}`);
  console.log(`   Remaining sessions: ${orchestrator.memory.getSessionCount()}\n`);

  await orchestrator.close();
  console.log('👋 Done!');
}

main().catch(console.error);
