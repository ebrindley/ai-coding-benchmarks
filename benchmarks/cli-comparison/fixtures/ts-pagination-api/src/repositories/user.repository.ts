export type User = {
  id: number;
  createdAt: string;
  name: string;
};

type FindAllParams = {
  page: number;
  pageSize: number;
};

const users: User[] = Array.from({ length: 100 }, (_, idx) => {
  const id = idx + 1;
  // Intentionally create a big tie group so OFFSET+unstable ordering is harmful.
  // IDs 1-25 share the same timestamp; after that it's unique.
  const createdAt =
    id <= 25 ? '2024-01-01T00:00:00.000Z' : new Date(2024, 0, 1, 0, 0, id).toISOString();
  return { id, createdAt, name: `user-${id}` };
});

let flipTieBreaker = false;

export class UserRepository {
  findAll({ page, pageSize }: FindAllParams): User[] {
    const start = (page - 1) * pageSize;

    // Seeded bug: missing secondary sort key. In real DBs, ties can be returned
    // in arbitrary order between requests, causing duplicates across pages.
    // We simulate this by flipping the tie breaker each call.
    flipTieBreaker = !flipTieBreaker;

    const sorted = [...users].sort((a, b) => {
      if (a.createdAt < b.createdAt) return -1;
      if (a.createdAt > b.createdAt) return 1;

      // BUG: unstable ordering for ties.
      return flipTieBreaker ? b.id - a.id : a.id - b.id;
    });

    return sorted.slice(start, start + pageSize);
  }

  getUserById(id: string): User | undefined {
    if (typeof id !== 'string' || id.trim() === '') {
      throw new TypeError('User ID must be a non-empty string');
    }
    const userId = parseInt(id, 10);
    return users.find((user) => user.id === userId);
  }
}
