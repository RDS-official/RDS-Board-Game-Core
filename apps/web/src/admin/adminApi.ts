export interface AdminUserItem {
  id: string;
  name: string;
  displayName: string;
  role: 'admin' | 'user';
  disabled: boolean;
  createdAt: number;
  avatarUrl?: string;
}

export interface AdminStats {
  totalUsers: number;
  adminUsers: number;
  disabledUsers: number;
}

export interface AdminUsersResponse {
  users: AdminUserItem[];
  stats: AdminStats;
}

const authHeader = () => ({
  Authorization: 'Bearer ' + (localStorage.getItem('token') ?? ''),
});

async function adminRequest<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...authHeader(),
      ...init.headers,
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `请求失败 (${res.status})`);
  }
  return data as T;
}

export async function getAdminUsers(): Promise<AdminUsersResponse> {
  return adminRequest<AdminUsersResponse>('/api/admin/users');
}

export async function createAdminUser(payload: {
  name: string;
  password: string;
  displayName?: string;
  role?: 'admin' | 'user';
}): Promise<{ user: AdminUserItem }> {
  return adminRequest<{ user: AdminUserItem }>('/api/admin/users', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function updateAdminUser(
  id: string,
  payload: {
    displayName?: string;
    role?: 'admin' | 'user';
    disabled?: boolean;
  }
): Promise<{ user: AdminUserItem }> {
  return adminRequest<{ user: AdminUserItem }>(`/api/admin/users/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
}

export async function resetUserPassword(id: string, password: string): Promise<{ ok: true }> {
  return adminRequest<{ ok: true }>(`/api/admin/users/${encodeURIComponent(id)}/password`, {
    method: 'POST',
    body: JSON.stringify({ password }),
  });
}

export async function deleteAdminUser(id: string): Promise<{ ok: true }> {
  return adminRequest<{ ok: true }>(`/api/admin/users/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}
