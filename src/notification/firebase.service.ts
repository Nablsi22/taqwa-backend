import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import * as admin from 'firebase-admin';
import * as path from 'path';
import * as fs from 'fs';

@Injectable()
export class FirebaseService implements OnModuleInit {
  private readonly logger = new Logger(FirebaseService.name);

  onModuleInit() {
    if (admin.apps.length > 0) {
      this.logger.log('Firebase already initialized');
      return;
    }

    const keyPath = path.join(process.cwd(), 'firebase-admin-key.json');

    if (!fs.existsSync(keyPath)) {
      this.logger.warn(
        'firebase-admin-key.json not found — push notifications disabled',
      );
      return;
    }

    try {
      const serviceAccount = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
      });
      this.logger.log('Firebase Admin SDK initialized successfully');
    } catch (error) {
      this.logger.error('Failed to initialize Firebase:', error.message);
    }
  }

  /**
   * Send push notification to a single device
   */
  async sendToDevice(
    token: string,
    title: string,
    body: string,
    data?: Record<string, string>,
  ): Promise<boolean> {
    if (!admin.apps.length || !token) return false;

    try {
      await admin.messaging().send({
        token,
        notification: { title, body },
        data: data || {},
        android: {
          priority: 'high',
          notification: {
            sound: 'default',
            channelId: 'taqwa_announcements',
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
      });
      this.logger.log(`Notification sent to token: ${token.substring(0, 20)}...`);
      return true;
    } catch (error) {
      this.logger.error(`Failed to send notification: ${error.message}`);
      // If token is invalid, return false so caller can clean it up
      if (
        error.code === 'messaging/invalid-registration-token' ||
        error.code === 'messaging/registration-token-not-registered'
      ) {
        return false;
      }
      return false;
    }
  }

  /**
   * Send push notification to multiple devices
   */
  async sendToMultipleDevices(
    tokens: string[],
    title: string,
    body: string,
    data?: Record<string, string>,
  ): Promise<{ success: number; failure: number; invalidTokens: string[] }> {
    if (!admin.apps.length || tokens.length === 0) {
      return { success: 0, failure: 0, invalidTokens: [] };
    }

    const validTokens = tokens.filter((t) => t && t.length > 0);
    if (validTokens.length === 0) {
      return { success: 0, failure: 0, invalidTokens: [] };
    }

    try {
      const message: admin.messaging.MulticastMessage = {
        tokens: validTokens,
        notification: { title, body },
        data: data || {},
        android: {
          priority: 'high',
          notification: {
            sound: 'default',
            channelId: 'taqwa_announcements',
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
        if (
          !resp.success &&
          resp.error &&
          (resp.error.code === 'messaging/invalid-registration-token' ||
            resp.error.code === 'messaging/registration-token-not-registered')
        ) {
          invalidTokens.push(validTokens[idx]);
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
