import { Module, Global } from '@nestjs/common';
import { NotificationController } from './notification.controller';
import { NotificationService } from './notification.service';
import { FirebaseService } from './firebase.service';
import { PrismaModule } from '../prisma/prisma.module';

@Global()
@Module({
  imports: [PrismaModule],
  controllers: [NotificationController],
  providers: [FirebaseService, NotificationService],
  exports: [NotificationService, FirebaseService],
})
export class NotificationModule {}
