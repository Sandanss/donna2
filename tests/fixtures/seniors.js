/**
 * Test fixtures for senior data
 */

export const dorothy = {
  id: 'senior-dorothy',
  name: 'Dorothy',
  phone: '+15559876543',
  timezone: 'America/New_York',
  interests: ['gardening', 'baking', 'church', 'bingo'],
  family: {
    daughter: 'Susan',
    grandson: 'Tommy',
    pet: 'cat named Whiskers',
  },
  profileNotes: 'Prefers short morning check-ins and gardening topics.',
  isActive: true,
  createdAt: new Date('2024-01-15'),
  updatedAt: new Date('2024-06-01'),
};

export const harold = {
  id: 'senior-harold',
  name: 'Harold',
  phone: '+15551234567',
  timezone: 'America/Chicago',
  interests: ['baseball', 'woodworking', 'fishing'],
  family: {
    son: 'Robert',
    granddaughter: 'Emily',
    wife: 'Margaret (deceased)',
  },
  profileNotes: 'Prefers Spanish conversation and evening check-ins.',
  isActive: true,
  createdAt: new Date('2024-02-01'),
  updatedAt: new Date('2024-06-15'),
};

export const margaret = {
  id: 'senior-margaret',
  name: 'Margaret',
  phone: '+15555555555',
  timezone: 'America/Los_Angeles',
  interests: ['reading', 'bridge', 'knitting'],
  family: {
    daughter: 'Karen',
    son: 'Michael',
    grandchildren: 'Three grandchildren',
  },
  profileNotes: 'Prefers slower speech and practical conversation.',
  isActive: true,
  createdAt: new Date('2024-03-10'),
  updatedAt: new Date('2024-07-01'),
};

// Inactive senior for testing filters
export const inactiveErnest = {
  id: 'senior-ernest',
  name: 'Ernest',
  phone: '+15550000000',
  timezone: 'America/Denver',
  interests: ['chess'],
  family: {},
  profileNotes: null,
  isActive: false,
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-04-01'),
};

// All test seniors
export const allSeniors = [dorothy, harold, margaret, inactiveErnest];
export const activeSeniors = [dorothy, harold, margaret];

export default {
  dorothy,
  harold,
  margaret,
  inactiveErnest,
  allSeniors,
  activeSeniors,
};
