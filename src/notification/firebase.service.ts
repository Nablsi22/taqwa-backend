import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as admin from 'firebase-admin';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class FirebaseService implements OnModuleInit {
  private readonly logger = new Logger(FirebaseService.name);
  private initialized = false;

  onModuleInit() {
    this.initialize();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // INITIALIZATION
  // Priority order:
  //   1. FIREBASE_SERVICE_ACCOUNT env var (production / Railway)
  //   2. firebase-admin-key.json file in backend root (local dev)
  // ═══════════════════════════════════════════════════════════════════════════
  private initialize() {
    if (admin.apps.length > 0) {
      this.initialized = true;
      return;
    }

    try {
      const serviceAccount = this.loadServiceAccount();

      if (!serviceAccount) {
        this.logger.warn(
          'Firebase service account not found — push notifications disabled',
        );
        return;
      }

      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
      });

      this.initialized = true;
      this.logger.log('Firebase Admin SDK initialized successfully');
    } catch (error) {
      this.logger.error(
        `Failed to initialize Firebase Admin SDK: ${error.message}`,
      );
    }
  }

  private loadServiceAccount(): admin.ServiceAccount | null {
    // 1. Try environment variable (production)
    const envValue = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (envValue && envValue.trim().length > 0) {
      try {
        const parsed = JSON.parse(envValue);
        this.logger.log(
          'Loading Firebase credentials from FIREBASE_SERVICE_ACCOUNT env var',
        );
        return parsed as admin.ServiceAccount;
      } catch (err) {
        this.logger.error(
          `FIREBASE_SERVICE_ACCOUNT env var is not valid JSON: ${err.message}`,
        );
        return null;
      }
    }

    // 2. Fall back to local file (dev)
    const filePath = path.join(process.cwd(), 'firebase-admin-key.json');
    if (fs.existsSync(filePath)) {
      try {
        const fileContent = fs.readFileSync(filePath, 'utf8');
        this.logger.log(
          'Loading Firebase credentials from firebase-admin-key.json file',
        );
        return JSON.parse(fileContent) as admin.ServiceAccount;
      } catch (err) {
        this.logger.error(
          `Failed to read firebase-admin-key.json: ${err.message}`,
        );
        return null;
      }
    }

    this.logger.warn('firebase-admin-key.json not found and FIREBASE_SERVICE_ACCOUNT env var not set');
    return null;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SEND TO SINGLE DEVICE
  // ═══════════════════════════════════════════════════════════════════════════
  async sendToDevice(
    token: string,
    title: string,
    body: string,
    data?: Record<string, string>,
  ): Promise<boolean> {
    if (!this.initialized) {
      this.logger.warn('Firebase not initialized — skipping send');
      return false;
    }

    try {
      const message: admin.messaging.Message = {
        token,
        notification: { title, body },
        data: data ?? {},
        android: {
          priority: 'high',
          notification: {
            sound: 'default',
            channelId: 'taqwa_default',
          },
        },
        apns: {
          payload: {
            aps: {
              sound: 'default',
              badge: 1,
            },
          },
        },
      };

      await admin.messaging().send(message);
      return true;
    } catch (error) {
      this.logger.error(`Failed to send to device: ${error.message}`);
      return false;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SEND TO MULTIPLE DEVICES (multicast)
  // ═══════════════════════════════════════════════════════════════════════════
  async sendToMultipleDevices(
    tokens: string[],
    title: string,
    body: string,
    data?: Record<string, string>,
  ): Promise<{
    success: number;
    failure: number;
    invalidTokens: string[];
  }> {
    if (!this.initialized) {
      this.logger.warn('Firebase not initialized — skipping multicast');
      return { success: 0, failure: tokens.length, invalidTokens: [] };
    }

    const validTokens = tokens.filter((t) => t && t.length > 0);
    if (validTokens.length === 0) {
      return { success: 0, failure: 0, invalidTokens: [] };
    }

    try {
      const message: admin.messaging.MulticastMessage = {
        tokens: validTokens,
        notification: { title, body },
        data: data ?? {},
        android: {
          priority: 'high',
          notification: {
            sound: 'default',
            channelId: 'taqwa_default',
          },
        },
        apns: {
          payload: {
            aps: {
              sound: 'default',
              badge: 1,
            },
          },
        },
      };

      const response = await admin.messaging().sendEachForMulticast(message);

      const invalidTokens: string[] = [];
      response.responses.forEach((resp, idx) => {
        if (!resp.success) {
          const errorCode = resp.error?.code;
          if (
            errorCode === 'messaging/invalid-registration-token' ||
            errorCode === 'messaging/registration-token-not-registered'
          ) {
            invalidTokens.push(validTokens[idx]);
          }
        }
      });

      this.logger.log(
        `Notifications sent: ${response.successCount} success, ${response.failureCount} failed`,
      );

      return {
        success: response.successCount,
        failure: response.failureCount,
        invalidTokens,
      };
    } catch (error) {
      this.logger.error(`Failed to send multicast: ${error.message}`);
      return { success: 0, failure: validTokens.length, invalidTokens: [] };
    }
  }
}