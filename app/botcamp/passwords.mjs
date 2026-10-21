import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scryptAsync = promisify(scrypt)
const KEY_LEN = 32

export async function hashPassword(password) {
  const salt = randomBytes(16).toString('base64url')
  const key = await scryptAsync(password, salt, KEY_LEN)
  return `scrypt$${salt}$${key.toString('base64url')}`
}

export async function verifyPassword(password, stored) {
  const parts = typeof stored === 'string' ? stored.split('$') : []
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false
  const [, salt, encoded] = parts
  let expected
  try { expected = Buffer.from(encoded, 'base64url') } catch { return false }
  if (expected.length !== KEY_LEN) return false
  const actual = await scryptAsync(String(password), salt, KEY_LEN)
  return timingSafeEqual(actual, expected)
}

export function normalizeEmail(email) {
  if (typeof email !== 'string') return ''
  return email.trim().toLowerCase()
}

export function validEmail(email) {
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

export function validPassword(password) {
  return typeof password === 'string' && password.length >= 8 && password.length <= 200
}
