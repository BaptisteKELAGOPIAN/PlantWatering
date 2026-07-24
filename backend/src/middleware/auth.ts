import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';

export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

export function safeComparePassword(password: string | undefined | null): boolean {
  if (!password || typeof password !== 'string') return false;
  
  const providedBuffer = Buffer.from(password, 'utf8');
  const expectedBuffer = Buffer.from(ADMIN_PASSWORD, 'utf8');

  if (providedBuffer.length !== expectedBuffer.length) {
    crypto.timingSafeEqual(expectedBuffer, expectedBuffer);
    return false;
  }
  return crypto.timingSafeEqual(providedBuffer, expectedBuffer);
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1];

  if (safeComparePassword(token)) {
    return next();
  }
  
  res.status(401).json({ 
    error: 'Action non autorisée en mode Démo. Veuillez vous connecter en Administrateur.' 
  });
}
