import { Model } from "@nozbe/watermelondb";
import { field, text, date } from "@nozbe/watermelondb/decorators";

export class Profile extends Model {
  static table = "profiles";
  @text("display_name") displayName!: string;
  @text("avatar_url") avatarUrl?: string;
  @text("bio") bio?: string;
  @text("custom_status") customStatus?: string;
  @field("is_public") isPublic!: boolean;
  @field("is_online") isOnline?: boolean;
  @field("last_seen_at") lastSeenAt?: number;
}

export class Room extends Model {
  static table = "rooms";
  @text("name") name?: string;
  @field("is_group") isGroup!: boolean;
  @field("is_e2ee") isE2ee!: boolean;
  @date("created_at") createdAt!: Date;
  @text("last_message_body") lastMessageBody?: string;
  @field("last_message_at") lastMessageAt?: number;
  @text("last_sender_id") lastSenderId?: string;
  @field("unread_count") unreadCount!: number;
  @text("other_user_id") otherUserId?: string;
  @text("other_user_name") otherUserName?: string;

  get title(): string {
    return this.isGroup ? (this.name ?? "Group") : (this.otherUserName ?? "Chat");
  }
}

export class Message extends Model {
  static table = "messages";
  @text("room_id") roomId!: string;
  @text("sender_id") senderId!: string;
  @text("body") body!: string;
  @text("msg_type") msgType!: string;
  @text("attachment_url") attachmentUrl?: string;
  @date("created_at") createdAt!: Date;
  @text("status") status!: string; // 'synced' | 'pending' | 'failed'
}
