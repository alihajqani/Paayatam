import { Module } from '@nestjs/common';
import { MessageCipher } from './message-cipher';

/**
 * The message key, and everything allowed to hold it (ADR-0009).
 *
 * ── Why this module exists at all ───────────────────────────────────────────
 *
 * `MessageCipher` is provided in a module rather than globally on purpose: a key
 * available everywhere is a key that eventually encrypts something nobody meant
 * to encrypt with it. Importing this module is therefore a **declaration** — the
 * list of importers is the answer to "who can decrypt with this key?", and it is
 * meant to stay short enough to read.
 *
 * ── Why it is no longer `ChatModule` (v0.8.0) ───────────────────────────────
 *
 * It used to live beside `ChatService`, which was the cipher's original and main
 * consumer. The anonymous conversation is gone and the key is not: three things
 * still use it, and none of them is a chat, so a module named for the removed
 * feature would have made the ownership question harder rather than easier.
 *
 * The consumers, each a deliberate widening rather than an accident:
 *
 *  1. **`DirectModule`** — «پیام مستقیم به میزبان», the product's only messaging.
 *  2. **`ConversationModule`** (ADR-0017), which encrypts half-filled bot forms
 *     with the same key and the same three columns. It decrypts only the draft
 *     belonging to the user whose update is being handled.
 *  3. **`AdminAccessModule`**, for M12's break-glass path, which decrypts a
 *     conversation for a moderator under a permission, an open case, a written
 *     reason and a fifteen-minute clock (T14).
 *
 * A fourth consumer should be argued for in an ADR, not added to this list.
 */
@Module({
  providers: [MessageCipher],
  exports: [MessageCipher],
})
export class CryptoModule {}
