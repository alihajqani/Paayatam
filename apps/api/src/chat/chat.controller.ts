import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ChatService, UserService } from '@payetam/domain';
import {
  chatMessagesQuery,
  closeChatRequest,
  sendChatMessageRequest,
  type ChatMessagesQuery,
  type ChatMessagesResponse,
  type ChatMessageView,
  type ChatSummaryView,
  type CloseChatRequest,
  type MyChatsResponse,
  type SendChatMessageRequest,
} from '@payetam/shared';
import { RateLimit } from '../common/rate-limit.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { CurrentUser, type AuthenticatedUser } from '../auth/auth.guard';
import { toChatMessagesResponse, toChatMessageView, toChatSummaryView } from './chat.view';

/**
 * The Mini App's side of the anonymous chat (plan §6).
 *
 * A thin adapter, like every other controller here: membership, chat state and
 * masking are decided in `ChatService`, because the bot reaches the same methods
 * and a rule enforced in a controller protects one surface. That is what makes
 * "the bot and the Mini App behave identically" true by construction rather than
 * by two implementations being kept in step (plan §3.3).
 */
@Controller('api/v1')
export class ChatController {
  constructor(
    private readonly chats: ChatService,
    private readonly users: UserService,
  ) {}

  /** Every conversation the caller is in, most recently active first. */
  @Get('chats')
  async mine(@CurrentUser() current: AuthenticatedUser): Promise<MyChatsResponse> {
    const userId = await this.users.resolveInternalId(current.publicId);
    const chats = await this.chats.listForUser(userId);
    return { chats: chats.map(toChatSummaryView) };
  }

  /**
   * One conversation, newest page first.
   *
   * Reading marks the caller's side read, which is why this is not a pure GET in
   * spirit even though it is one in shape. The alternative — a separate
   * `mark-read` call — produces an unread badge that is wrong whenever a client
   * forgets to make it.
   */
  @Get('chats/:publicId/messages')
  async messages(
    @Param('publicId') publicId: string,
    @Query(new ZodValidationPipe(chatMessagesQuery)) query: ChatMessagesQuery,
    @CurrentUser() current: AuthenticatedUser,
  ): Promise<ChatMessagesResponse> {
    const userId = await this.users.resolveInternalId(current.publicId);
    const page = await this.chats.readMessages(userId, publicId, {
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
      ...(query.beforeSeq !== undefined ? { beforeSeq: query.beforeSeq } : {}),
    });
    return toChatMessagesResponse(page);
  }

  /**
   * Say something.
   *
   * The response is the message *as relayed*, not as typed: if a phone number was
   * masked, the sender sees the masking and the `redactionKinds` that explain it.
   * Showing the sender their own unmasked text would let them believe a number
   * arrived when it did not, which is the one misunderstanding this feature
   * cannot afford.
   *
   * No entities are accepted from this surface at all — the Mini App composes
   * plain text. The bot's path, which does carry Telegram entities, drops every
   * one of them in the same sanitizer.
   */
  @Post('chats/:publicId/messages')
  @RateLimit('CHAT_SEND')
  async send(
    @Param('publicId') publicId: string,
    @Body(new ZodValidationPipe(sendChatMessageRequest)) body: SendChatMessageRequest,
    @CurrentUser() current: AuthenticatedUser,
  ): Promise<ChatMessageView> {
    const userId = await this.users.resolveInternalId(current.publicId);
    return toChatMessageView(await this.chats.send(userId, publicId, { text: body.text }));
  }

  /** Either party ends the conversation. Neither needs the other's agreement. */
  @Post('chats/:publicId/close')
  async close(
    @Param('publicId') publicId: string,
    @Body(new ZodValidationPipe(closeChatRequest)) body: CloseChatRequest,
    @CurrentUser() current: AuthenticatedUser,
  ): Promise<ChatSummaryView> {
    const userId = await this.users.resolveInternalId(current.publicId);
    return toChatSummaryView(await this.chats.close(userId, publicId, body.reason));
  }

  /**
   * Consent to exchange contact details in this chat.
   *
   * It reveals nothing by itself. The platform holds no phone number and will not
   * surrender a Telegram username; what changes is that the caller's own messages
   * stop being masked, so they can send their details themselves. The disclosure
   * stays the user's act, which is what ADR-0009 requires of it.
   */
  @Post('chats/:publicId/share-contact')
  async shareContact(
    @Param('publicId') publicId: string,
    @CurrentUser() current: AuthenticatedUser,
  ): Promise<ChatSummaryView> {
    const userId = await this.users.resolveInternalId(current.publicId);
    return toChatSummaryView(await this.chats.shareContact(userId, publicId));
  }
}
