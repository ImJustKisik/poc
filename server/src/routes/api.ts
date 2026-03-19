// ============================================================
// PCM Server — API Routes
// ============================================================

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { db, schema } from '../db/index.js';
import { eq, and, inArray } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import { MAX_GROUP_SIZE, ConversationType, WSEventType, type Conversation } from '@pcm/shared';
import { wsHub } from '../ws/hub.js';

function toConversationDto(
  conversation: typeof schema.conversations.$inferSelect,
  memberIds: string[],
): Conversation {
  return {
    id: conversation.id,
    type: conversation.type as ConversationType,
    name: conversation.name || undefined,
    avatar: conversation.avatar || undefined,
    members: memberIds,
    createdBy: conversation.createdBy,
    createdAt: conversation.createdAt,
    unreadCount: 0,
    muted: false,
    pinned: false,
  };
}

export function registerApiRoutes(app: FastifyInstance) {
  // ---- User routes ----

  app.get('/api/users/:userId', {
    preHandler: [app.authenticate],
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { userId } = request.params as { userId: string };
    const users = await db.select({
      id: schema.users.id,
      publicKey: schema.users.publicKey,
      displayName: schema.users.displayName,
      avatar: schema.users.avatar,
      customStatus: schema.users.customStatus,
      lastSeen: schema.users.lastSeen,
    }).from(schema.users).where(eq(schema.users.id, userId));

    if (users.length === 0) {
      return reply.code(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'User not found' } });
    }

    return reply.send({ success: true, data: users[0] });
  });

  app.get('/api/users/key/:publicKey', {
    preHandler: [app.authenticate],
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { publicKey } = request.params as { publicKey: string };
    const users = await db.select({
      id: schema.users.id,
      publicKey: schema.users.publicKey,
      displayName: schema.users.displayName,
      avatar: schema.users.avatar,
    }).from(schema.users).where(eq(schema.users.publicKey, decodeURIComponent(publicKey)));

    if (users.length === 0) {
      return reply.code(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'User not found' } });
    }

    return reply.send({ success: true, data: users[0] });
  });

  app.put('/api/users/profile', {
    preHandler: [app.authenticate],
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { userId } = request.user as { userId: string };
    const body = request.body as { displayName?: string; avatar?: string; customStatus?: string };

    await db.update(schema.users).set({
      ...(body.displayName && { displayName: body.displayName }),
      ...(body.avatar !== undefined && { avatar: body.avatar }),
      ...(body.customStatus !== undefined && { customStatus: body.customStatus }),
    }).where(eq(schema.users.id, userId));

    return reply.send({ success: true });
  });

  // ---- Conversation routes ----

  app.get('/api/conversations', {
    preHandler: [app.authenticate],
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { userId } = request.user as { userId: string };

    const memberships = await db.select().from(schema.conversationMembers)
      .where(eq(schema.conversationMembers.userId, userId));

    const convIds = memberships.map(m => m.conversationId);
    if (convIds.length === 0) {
      return reply.send({ success: true, data: [] });
    }

    const convs = await db.select().from(schema.conversations)
      .where(inArray(schema.conversations.id, convIds));

    // Fetch members for each conversation
    const allMembers = await db.select().from(schema.conversationMembers)
      .where(inArray(schema.conversationMembers.conversationId, convIds));

    const result = convs.map(c =>
      toConversationDto(
        c,
        allMembers.filter(m => m.conversationId === c.id).map(m => m.userId),
      )
    );

    return reply.send({ success: true, data: result });
  });

  app.post('/api/conversations', {
    preHandler: [app.authenticate],
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { userId } = request.user as { userId: string };
    const body = request.body as {
      type: 'direct' | 'group';
      name?: string;
      memberIds: string[];
    };
    const requestedMembers = Array.from(new Set(body.memberIds.filter(Boolean)));

    if (body.type === 'direct' && requestedMembers.length !== 1) {
      return reply.code(400).send({
        success: false,
        error: { code: 'INVALID_MEMBERS', message: 'Direct conversation requires exactly one peer' },
      });
    }

    if (body.type === 'group' && requestedMembers.length > MAX_GROUP_SIZE) {
      return reply.code(400).send({
        success: false,
        error: { code: 'GROUP_TOO_LARGE', message: `Max group size is ${MAX_GROUP_SIZE}` },
      });
    }

    // For direct chats, check if conversation already exists
    if (body.type === 'direct' && requestedMembers.length === 1) {
      const otherUserId = requestedMembers[0];
      const existingMemberships = await db.select().from(schema.conversationMembers)
        .where(eq(schema.conversationMembers.userId, userId));

      for (const membership of existingMemberships) {
        const conv = await db.select().from(schema.conversations)
          .where(and(
            eq(schema.conversations.id, membership.conversationId),
            eq(schema.conversations.type, 'direct'),
          ));

        if (conv.length > 0) {
          const otherMember = await db.select().from(schema.conversationMembers)
            .where(and(
              eq(schema.conversationMembers.conversationId, conv[0].id),
              eq(schema.conversationMembers.userId, otherUserId),
            ));
          if (otherMember.length > 0) {
            const directMembers = await db.select().from(schema.conversationMembers)
              .where(eq(schema.conversationMembers.conversationId, conv[0].id));

            return reply.send({
              success: true,
              data: { ...toConversationDto(conv[0], directMembers.map(member => member.userId)), existing: true },
            });
          }
        }
      }
    }

    const conversation = await db.transaction(async (tx) => {
      const users = await tx.select({ id: schema.users.id }).from(schema.users)
        .where(inArray(schema.users.id, requestedMembers));

      if (users.length !== requestedMembers.length) {
        throw new Error('INVALID_MEMBERS');
      }

      const convId = uuid();
      const now = Date.now();
      const allMembers = [userId, ...requestedMembers.filter(id => id !== userId)];

      await tx.insert(schema.conversations).values({
        id: convId,
        type: body.type,
        name: body.name || null,
        createdBy: userId,
        createdAt: now,
      });

      await tx.insert(schema.conversationMembers).values(
        allMembers.map((memberId, i) => ({
          conversationId: convId,
          userId: memberId,
          role: i === 0 ? 'admin' : 'member',
          joinedAt: now,
        }))
      );

      return toConversationDto({
        id: convId,
        type: body.type,
        name: body.name || null,
        avatar: null,
        createdBy: userId,
        createdAt: now,
      }, allMembers);
    }).catch((error: Error) => {
      if (error.message === 'INVALID_MEMBERS') {
        return null;
      }
      throw error;
    });

    if (!conversation) {
      return reply.code(400).send({
        success: false,
        error: { code: 'INVALID_MEMBERS', message: 'One or more members do not exist' },
      });
    }

    for (const memberId of conversation.members) {
      if (memberId === userId) continue;
      wsHub.sendToUser(memberId, {
        event: WSEventType.CONVERSATION_CREATE,
        data: conversation,
        timestamp: Date.now(),
      });
    }

    return reply.send({ success: true, data: conversation });
  });

  app.post('/api/conversations/:conversationId/members', {
    preHandler: [app.authenticate],
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { userId } = request.user as { userId: string };
    const { conversationId } = request.params as { conversationId: string };
    const { memberIds } = request.body as { memberIds: string[] };
    const uniqueMemberIds = Array.from(new Set(memberIds.filter(Boolean)));

    // Verify admin
    const membership = await db.select().from(schema.conversationMembers)
      .where(and(
        eq(schema.conversationMembers.conversationId, conversationId),
        eq(schema.conversationMembers.userId, userId),
      ));

    if (membership.length === 0 || membership[0].role !== 'admin') {
      return reply.code(403).send({ success: false, error: { code: 'FORBIDDEN', message: 'Only admins can add members' } });
    }

    // Check group size
    const currentMembers = await db.select().from(schema.conversationMembers)
      .where(eq(schema.conversationMembers.conversationId, conversationId));

    if (currentMembers.length + uniqueMemberIds.length > MAX_GROUP_SIZE) {
      return reply.code(400).send({
        success: false,
        error: { code: 'GROUP_TOO_LARGE', message: `Max group size is ${MAX_GROUP_SIZE}` },
      });
    }

    const existingMemberIds = new Set(currentMembers.map(member => member.userId));
    const users = await db.select({ id: schema.users.id }).from(schema.users)
      .where(inArray(schema.users.id, uniqueMemberIds));

    if (users.length !== uniqueMemberIds.length) {
      return reply.code(400).send({
        success: false,
        error: { code: 'INVALID_MEMBERS', message: 'One or more members do not exist' },
      });
    }

    const now = Date.now();
    const newMembers = uniqueMemberIds.filter(memberId => !existingMemberIds.has(memberId)).map(memberId => ({
      conversationId,
      userId: memberId,
      role: 'member',
      joinedAt: now,
    }));

    if (newMembers.length > 0) {
      await db.insert(schema.conversationMembers).values(newMembers);
    }

    return reply.send({ success: true });
  });
}
