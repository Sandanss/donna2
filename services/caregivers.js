import { db } from '../db/client.js';
import { caregivers, seniors } from '../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { createLogger } from '../lib/logger.js';

const log = createLogger('Caregiver');

function publicCaregiverProfile(assignment) {
  if (!assignment) return null;
  return {
    id: assignment.id,
    phone: assignment.phone,
    timezone: assignment.timezone,
    city: assignment.city,
    state: assignment.state,
    zipCode: assignment.zipCode,
    role: assignment.role,
  };
}

export const caregiverService = {
  // Link a Clerk user to a senior (creates caregiver assignment, skips if already linked)
  async linkUserToSenior(clerkUserId, seniorId, role = 'caregiver') {
    // Check if already linked
    const existing = await this.getAssignment(clerkUserId, seniorId);
    if (existing) {
      log.info('User already linked to senior, skipping', { userId: clerkUserId, seniorId });
      return existing;
    }

    const [assignment] = await db.insert(caregivers).values({
      clerkUserId,
      seniorId,
      role,
    }).returning();

    log.info('Linked user to senior', { userId: clerkUserId, seniorId, role });
    return assignment;
  },

  // Get all seniors accessible by a Clerk user
  async getSeniorsForUser(clerkUserId) {
    const assignments = await db.select({
      assignment: caregivers,
      senior: seniors,
    })
      .from(caregivers)
      .innerJoin(seniors, eq(caregivers.seniorId, seniors.id))
      .where(and(
        eq(caregivers.clerkUserId, clerkUserId),
        eq(seniors.isActive, true)
      ));

    return assignments.map(a => ({
      ...a.senior,
      role: a.assignment.role,
    }));
  },

  async getProfileForUser(clerkUserId) {
    const assignments = await db.select({
      assignment: caregivers,
      senior: seniors,
    })
      .from(caregivers)
      .innerJoin(seniors, eq(caregivers.seniorId, seniors.id))
      .where(and(
        eq(caregivers.clerkUserId, clerkUserId),
        eq(seniors.isActive, true)
      ));

    return {
      caregiver: publicCaregiverProfile(assignments[0]?.assignment),
      seniors: assignments.map(a => ({
        ...a.senior,
        role: a.assignment.role,
      })),
    };
  },

  // Check if a Clerk user can access a senior
  async canAccessSenior(clerkUserId, seniorId) {
    const [assignment] = await db.select()
      .from(caregivers)
      .where(and(
        eq(caregivers.clerkUserId, clerkUserId),
        eq(caregivers.seniorId, seniorId)
      ))
      .limit(1);
    return !!assignment;
  },

  // Get all Clerk users who can access a senior
  async getUsersForSenior(seniorId) {
    const assignments = await db.select()
      .from(caregivers)
      .where(eq(caregivers.seniorId, seniorId));

    return assignments.map(a => ({
      clerkUserId: a.clerkUserId,
      role: a.role,
    }));
  },

  // Remove a user's access to a senior
  async unlinkUserFromSenior(clerkUserId, seniorId) {
    const result = await db.delete(caregivers)
      .where(and(
        eq(caregivers.clerkUserId, clerkUserId),
        eq(caregivers.seniorId, seniorId)
      ))
      .returning();

    return result.length > 0;
  },

  // Get assignment details
  async getAssignment(clerkUserId, seniorId) {
    const [assignment] = await db.select()
      .from(caregivers)
      .where(and(
        eq(caregivers.clerkUserId, clerkUserId),
        eq(caregivers.seniorId, seniorId)
      ));
    return assignment || null;
  },
};
