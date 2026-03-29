/**
 * Agent Orcha iOS P2P Client
 *
 * Consumer-only Hyperswarm peer that runs inside the Bare runtime.
 * Communicates with Swift via BareKit.IPC using NDJSON.
 *
 * This is a subset of lib/p2p/p2p-manager.ts — it only discovers
 * peers and invokes remote agents/LLMs, never serves any.
 */

/* global Bare, BareKit */

const Hyperswarm = require('hyperswarm')
const crypto = require('bare-crypto')
const b4a = require('b4a')

const IPC = BareKit.IPC
const VERSION = '1.0.0'

// --- State ---

let swarm = null
let localPeerId = null
let peerName = 'iOS'
const peers = new Map() // peerId -> { socket, protocol, info }

// --- NDJSON Protocol (mirrors lib/p2p/p2p-protocol.ts) ---

class Protocol {
  constructor (socket) {
    this.socket = socket
    this.buffer = ''
    this.handlers = new Map()
    this.destroyed = false

    socket.on('data', (data) => this._onData(data))
    socket.on('error', () => this.destroy())
    socket.on('close', () => this.destroy())
  }

  on (type, handler) {
    this.handlers.set(type, handler)
  }

  send (message) {
    if (this.destroyed) return
    try {
      this.socket.write(JSON.stringify(message) + '\n')
    } catch (err) {
      // Socket may be closing
    }
  }

  destroy () {
    if (this.destroyed) return
    this.destroyed = true
    this.handlers.clear()
    try { this.socket.destroy() } catch (err) { /* socket already closing */ }
  }

  _onData (data) {
    this.buffer += data.toString()
    const lines = this.buffer.split('\n')
    this.buffer = lines.pop() || ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const msg = JSON.parse(trimmed)
        const handler = this.handlers.get(msg.type)
        if (handler) handler(msg)
      } catch (err) {
        // Ignore malformed messages
      }
    }
  }
}

// --- Content Filters ---

// Track whether we're inside a tool_call block so we can suppress all tokens within it
let inToolCallBlock = false

/**
 * Filter content chunks that are tool-call XML markup from the LLM's raw output.
 * The LLM streams token-by-token, so `<tool_call>` may arrive as one chunk and
 * the closing `</tool_call>` many chunks later. We track state to suppress the
 * entire block.
 * Returns true if this chunk should be hidden from the UI.
 */
function shouldFilterContent (text) {
  if (typeof text !== 'string') return false
  const trimmed = text.trim()
  if (!trimmed) return false

  // Detect start of tool_call or tool_history block
  if (trimmed.includes('<tool_call>') || trimmed.startsWith('<tool_call') ||
      trimmed.includes('<tool_history>') || trimmed.startsWith('<tool_history')) {
    inToolCallBlock = true
    return true
  }

  // Inside a block — suppress everything until closing tag
  if (inToolCallBlock) {
    if (trimmed.includes('</tool_call>') || trimmed.includes('</\ntool_call>') ||
        trimmed.includes('</tool_history>')) {
      inToolCallBlock = false
    }
    return true
  }

  // Standalone internal tags that might arrive outside tracked state
  if (/^<\/?(?:tool_call|tool_history|function=|parameter=|\/function|\/parameter)/.test(trimmed)) {
    return true
  }

  return false
}

/** Detect raw JSON event metadata that leaked into a string chunk */
function isRawEventJSON (text) {
  if (typeof text !== 'string') return false
  const trimmed = text.trim()
  if (!trimmed.startsWith('{')) return false
  try {
    const obj = JSON.parse(trimmed)
    // Known metadata event types that should not be shown as content
    return obj.type === 'react_iteration' || obj.type === 'usage' || obj.type === 'result' || obj.type === 'warning'
  } catch {
    return false
  }
}

// --- IPC Communication ---

function sendEvent (event) {
  IPC.write(JSON.stringify(event) + '\n')
}

// --- IPC Command Buffer ---

let ipcBuffer = ''

function processIPCData (data) {
  ipcBuffer += data.toString()
  const lines = ipcBuffer.split('\n')
  ipcBuffer = lines.pop() || ''

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const cmd = JSON.parse(trimmed)
      handleCommand(cmd)
    } catch (err) {
      sendEvent({ event: 'error', message: 'Invalid IPC command: ' + err.message })
    }
  }
}

// --- Command Handler ---

function handleCommand (cmd) {
  switch (cmd.cmd) {
    case 'connect':
      connect(cmd.networkKey, cmd.peerName)
      break
    case 'disconnect':
      disconnect()
      break
    case 'invoke_agent':
      invokeAgent(cmd.requestId, cmd.peerId, cmd.agentName, cmd.input, cmd.sessionId, cmd.attachments)
      break
    case 'invoke_llm':
      invokeLLM(cmd.requestId, cmd.peerId, cmd.modelName, cmd.messages, cmd.sessionId)
      break
    case 'request_leaderboard':
      requestLeaderboard(cmd.requestId)
      break
    case 'abort':
      abortRequest(cmd.requestId)
      break
    default:
      sendEvent({ event: 'error', message: 'Unknown command: ' + cmd.cmd })
  }
}

// --- Hyperswarm Connection ---

async function connect (networkKey, name) {
  if (swarm) {
    await disconnect()
  }

  peerName = name || 'iOS'
  localPeerId = b4a.toString(crypto.randomBytes(16), 'hex')

  swarm = new Hyperswarm()

  const topicBuffer = crypto.createHash('sha256').update(b4a.from(networkKey)).digest()

  swarm.on('connection', (socket, info) => {
    onConnection(socket, info)
  })

  const discovery = swarm.join(topicBuffer, { server: true, client: true })
  await discovery.flushed()

  sendEvent({ event: 'connected', peerCount: peers.size })
}

async function disconnect () {
  if (!swarm) return

  for (const [peerId, peer] of peers) {
    peer.protocol.destroy()
  }
  peers.clear()

  try {
    await swarm.destroy()
  } catch (err) {
    // Swarm may already be closing
  }
  swarm = null

  sendEvent({ event: 'disconnected' })
}

// --- Peer Connection Handling ---

function onConnection (socket, _info) {
  const protocol = new Protocol(socket)

  // Send handshake immediately (consumer-only: empty agents/models)
  const handshake = {
    type: 'handshake',
    peerId: localPeerId,
    peerName: peerName,
    version: VERSION,
    agents: [],
    models: []
  }
  protocol.send(handshake)

  // Handle incoming handshake
  protocol.on('handshake', (msg) => {
    if (msg.peerId === localPeerId) {
      // Connected to ourselves
      protocol.destroy()
      return
    }

    // Deduplicate
    if (peers.has(msg.peerId)) {
      protocol.destroy()
      return
    }

    const peerInfo = {
      peerId: msg.peerId,
      peerName: msg.peerName,
      version: msg.version,
      agents: msg.agents || [],
      models: msg.models || msg.llms || [],
      load: 0,
      stats: null,
      connectedAt: Date.now()
    }

    peers.set(msg.peerId, { socket, protocol, info: peerInfo })
    setupPeerHandlers(msg.peerId, protocol)

    sendEvent({ event: 'peer_joined', peer: peerInfo })
  })

  // Handle disconnect
  socket.on('close', () => {
    for (const [peerId, peer] of peers) {
      if (peer.protocol === protocol) {
        peers.delete(peerId)
        sendEvent({ event: 'peer_left', peerId })
        break
      }
    }
  })
}

function setupPeerHandlers (peerId, protocol) {
  // Catalog updates
  protocol.on('catalog', (msg) => {
    const peer = peers.get(peerId)
    if (!peer) return
    peer.info.agents = msg.agents || []
    peer.info.models = msg.models || msg.llms || []
    peer.info.load = msg.load || 0
    peer.info.stats = msg.stats || null
    if (msg.peerName) peer.info.peerName = msg.peerName

    sendEvent({
      event: 'catalog_update',
      peerId,
      agents: peer.info.agents,
      models: peer.info.models,
      load: peer.info.load,
      stats: peer.info.stats
    })
  })

  // Agent stream responses — server sends rich typed chunks
  protocol.on('stream', (msg) => {
    const chunk = msg.chunk
    if (chunk && typeof chunk === 'object' && chunk.type) {
      // Rich typed event from server
      switch (chunk.type) {
        case 'content': {
          const text = chunk.content || ''
          // Filter out raw tool call XML that some models emit as content
          if (text && !shouldFilterContent(text)) {
            sendEvent({
              event: 'stream_chunk',
              requestId: msg.requestId,
              chunkType: 'content',
              content: text
            })
          }
          break
        }
        case 'thinking':
          sendEvent({
            event: 'stream_chunk',
            requestId: msg.requestId,
            chunkType: 'thinking',
            content: chunk.content || ''
          })
          break
        case 'tool_start':
          sendEvent({
            event: 'stream_event',
            requestId: msg.requestId,
            eventType: 'tool_start',
            tool: chunk.tool,
            input: typeof chunk.input === 'string' ? chunk.input : JSON.stringify(chunk.input || {}),
            runId: chunk.runId || ''
          })
          break
        case 'tool_end':
          sendEvent({
            event: 'stream_event',
            requestId: msg.requestId,
            eventType: 'tool_end',
            tool: chunk.tool,
            output: typeof chunk.output === 'string' ? chunk.output : JSON.stringify(chunk.output || ''),
            runId: chunk.runId || ''
          })
          break
        case 'usage':
          sendEvent({
            event: 'stream_event',
            requestId: msg.requestId,
            eventType: 'usage',
            input_tokens: chunk.input_tokens || chunk.inputTokens || 0,
            output_tokens: chunk.output_tokens || chunk.outputTokens || 0,
            total_tokens: chunk.total_tokens || chunk.totalTokens || 0
          })
          break
        case 'react_iteration':
          // Internal ReAct loop markers — skip, don't forward to UI
          break
        default:
          // Unknown event type — only forward if it has actual content, skip metadata
          if (chunk.content && typeof chunk.content === 'string') {
            sendEvent({
              event: 'stream_chunk',
              requestId: msg.requestId,
              chunkType: 'content',
              content: chunk.content
            })
          }
          // else: silently drop non-content metadata events
      }
    } else if (typeof chunk === 'string') {
      // Plain string chunk — filter out tool call XML and raw JSON metadata
      if (!shouldFilterContent(chunk) && !isRawEventJSON(chunk)) {
        sendEvent({
          event: 'stream_chunk',
          requestId: msg.requestId,
          chunkType: 'content',
          content: chunk
        })
      }
    }
    // else: non-string, non-object chunk — drop silently
  })

  protocol.on('stream_end', (msg) => {
    inToolCallBlock = false // Reset filter state between requests
    sendEvent({
      event: 'stream_end',
      requestId: msg.requestId
    })
  })

  protocol.on('stream_error', (msg) => {
    sendEvent({
      event: 'stream_error',
      requestId: msg.requestId,
      error: msg.error
    })
  })

  // Model task responses (used for LLM chat via model_task_invoke)
  protocol.on('model_task_stream', (msg) => {
    const chunk = msg.chunk
    if (chunk && typeof chunk === 'object' && chunk.type) {
      switch (chunk.type) {
        case 'content':
          sendEvent({
            event: 'llm_chunk',
            requestId: msg.requestId,
            chunk: { type: 'content', content: chunk.content || '' }
          })
          break
        case 'thinking':
          sendEvent({
            event: 'llm_chunk',
            requestId: msg.requestId,
            chunk: { type: 'thinking', content: chunk.content || '' }
          })
          break
        case 'usage':
          sendEvent({
            event: 'llm_chunk',
            requestId: msg.requestId,
            chunk: {
              type: 'usage',
              input_tokens: chunk.input_tokens || chunk.inputTokens || 0,
              output_tokens: chunk.output_tokens || chunk.outputTokens || 0,
              total_tokens: chunk.total_tokens || chunk.totalTokens || 0
            }
          })
          break
        default:
          // tool_calls or other — forward as content
          if (chunk.content) {
            sendEvent({
              event: 'llm_chunk',
              requestId: msg.requestId,
              chunk: { type: 'content', content: chunk.content }
            })
          }
      }
    }
  })

  protocol.on('model_task_stream_end', (msg) => {
    sendEvent({
      event: 'llm_end',
      requestId: msg.requestId
    })
  })

  protocol.on('model_task_error', (msg) => {
    sendEvent({
      event: 'llm_error',
      requestId: msg.requestId,
      error: msg.error
    })
  })

  // Model task result (for non-streaming tasks like image/tts)
  protocol.on('model_task_result', (msg) => {
    // Not used directly by iOS consumer — results come through agent tool_end events
  })

  // Leaderboard responses
  protocol.on('leaderboard_response', (msg) => {
    sendEvent({
      event: 'leaderboard_response',
      requestId: msg.requestId,
      entries: msg.entries || []
    })
  })
}

// --- Agent Invocation ---

function invokeAgent (requestId, peerId, agentName, input, sessionId, attachments) {
  const peer = peers.get(peerId)
  if (!peer) {
    sendEvent({ event: 'stream_error', requestId, error: 'Peer not found: ' + peerId })
    return
  }

  const agentInput = Object.assign({}, input || {})

  // Embed attachments in the input for the remote agent to process
  if (attachments && attachments.length > 0) {
    agentInput.__attachments = attachments
  }

  const msg = {
    type: 'invoke',
    requestId,
    agentName,
    input: agentInput,
    sessionId: sessionId || ('ios-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8))
  }

  peer.protocol.send(msg)
}

// --- LLM Invocation (via model_task_invoke) ---

function invokeLLM (requestId, peerId, modelName, messages, sessionId) {
  const peer = peers.get(peerId)
  if (!peer) {
    sendEvent({ event: 'llm_error', requestId, error: 'Peer not found: ' + peerId })
    return
  }

  const msg = {
    type: 'model_task_invoke',
    requestId,
    taskType: 'chat',
    modelName,
    params: {
      messages: messages || []
    }
  }

  peer.protocol.send(msg)
}

// --- Leaderboard ---

function requestLeaderboard (requestId) {
  // Send to the first connected peer that can respond
  for (const [peerId, peer] of peers) {
    peer.protocol.send({
      type: 'leaderboard_request',
      requestId: requestId || ('lb-' + Date.now())
    })
    return // Only need one response
  }

  // No peers connected
  sendEvent({
    event: 'leaderboard_response',
    requestId: requestId || 'lb-nopeer',
    entries: []
  })
}

// --- Abort ---

function abortRequest (requestId) {
  // We can't truly abort a remote stream, but we can stop forwarding
  // The stream events will simply be ignored on the Swift side
  // since the continuation will already be finished
}

// --- Lifecycle ---

Bare.on('suspend', () => {
  if (swarm && typeof swarm.suspend === 'function') {
    swarm.suspend()
  }
})

Bare.on('resume', () => {
  if (swarm && typeof swarm.resume === 'function') {
    swarm.resume()
  }
})

// --- Initialize ---

IPC.setEncoding('utf8')
IPC.on('data', processIPCData)

sendEvent({ event: 'ready' })
