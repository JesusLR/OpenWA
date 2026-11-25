/**
 * Backport a bounded pre-auth readiness wait to whatsapp-web.js 1.34.7.
 * Debug.VERSION can exist before WAWebSocketModel is registered. Reading Socket
 * immediately then crashes both fresh QR creation and saved-session restores.
 * Wait for a settled socket state before exposing AuthStore or deciding whether
 * authentication is needed. Keep a truthy state string for authenticated sessions
 * too: returning false for CONNECTED would make Puppeteer wait until timeout.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const DEFAULT_WWJS = path.join(__dirname, '..', 'node_modules', 'whatsapp-web.js');

const ANCHOR = `        await this.pupPage.evaluate(ExposeAuthStore);

        const needAuthentication = await this.pupPage.evaluate(async () => {
            let state = window.require('WAWebSocketModel').Socket.state;

            if (
                state === 'OPENING' ||
                state === 'UNLAUNCHED' ||
                state === 'PAIRING'
            ) {
                // wait till state changes
                await new Promise((r) => {
                    window
                        .require('WAWebSocketModel')
                        .Socket.on(
                            'change:state',
                            function waitTillInit(_AppState, state) {
                                if (
                                    state !== 'OPENING' &&
                                    state !== 'UNLAUNCHED' &&
                                    state !== 'PAIRING'
                                ) {
                                    window
                                        .require('WAWebSocketModel')
                                        .Socket.off(
                                            'change:state',
                                            waitTillInit,
                                        );
                                    r();
                                }
                            },
                        );
                });
            }
            state = window.require('WAWebSocketModel').Socket.state;
            return state == 'UNPAIRED' || state == 'UNPAIRED_IDLE';
        });`;

const FIX = `        // OpenWA auth-ready repair: Debug.VERSION can precede the socket module.
        const authStateHandle = await this.pupPage.waitForFunction(
            () => {
                try {
                    const state = window.require?.('WAWebSocketModel')?.Socket?.state;
                    if (!state || ['OPENING', 'UNLAUNCHED', 'PAIRING'].includes(state)) {
                        return false;
                    }
                    return state;
                } catch {
                    // WhatsApp's module loader may not be initialized yet.
                    return false;
                }
            },
            { timeout: this.options.authTimeoutMs, polling: 200 },
        ).catch((error) => {
            if (error.name === 'TimeoutError') {
                throw new Error('WhatsApp Web socket initialization timed out before authentication');
            }
            throw error;
        });
        let authState;
        try {
            authState = await authStateHandle.jsonValue();
        } finally {
            await authStateHandle.dispose();
        }
        await this.pupPage.evaluate(ExposeAuthStore);
        const needAuthentication = authState === 'UNPAIRED' || authState === 'UNPAIRED_IDLE';`;

function applyBackport(wwjsDir = DEFAULT_WWJS) {
  const file = path.join(wwjsDir, 'src', 'Client.js');
  const raw = fs.readFileSync(file, 'utf8');
  const source = raw.replace(/\r\n/g, '\n');
  const anchors = source.split(ANCHOR).length - 1;
  const fixes = source.split(FIX).length - 1;
  if (anchors === 0 && fixes === 1) return { skipped: true, note: 'auth-ready wait already applied' };
  if (anchors !== 1 || fixes !== 0) {
    throw new Error(`unsupported Client.js shape (anchors: ${anchors}, fixes: ${fixes}); re-evaluate auth-ready repair`);
  }
  const newline = raw.includes('\r\n') ? '\r\n' : '\n';
  fs.writeFileSync(file, source.replace(ANCHOR, FIX).replace(/\n/g, newline));
  return { skipped: false, note: 'bounded socket readiness wait applied before authentication' };
}

// Startup diagnostics use the same stand-down check as the patcher itself.
function isApplied(wwjsDir = DEFAULT_WWJS) {
  try {
    const source = fs.readFileSync(path.join(wwjsDir, 'src', 'Client.js'), 'utf8').replace(/\r\n/g, '\n');
    return source.split(ANCHOR).length === 1 && source.split(FIX).length === 2;
  } catch {
    return true;
  }
}

if (require.main === module) {
  try {
    console.log(`patch-wwebjs-auth-ready: ${applyBackport().note}`);
  } catch (error) {
    const bestEffort = process.argv.includes('--best-effort');
    console[bestEffort ? 'warn' : 'error'](`patch-wwebjs-auth-ready: ${bestEffort ? 'skipped: ' : ''}${error.message}`);
    if (!bestEffort) process.exitCode = 1;
  }
}

module.exports = { applyBackport, isApplied, ANCHOR, FIX };
