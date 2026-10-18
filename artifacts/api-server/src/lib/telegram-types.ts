export type TelegramUser = {
  id: number;
  first_name?: string;
  username?: string;
  is_bot?: boolean;
};

export type TelegramChat = {
  id: number;
  type: string;
};

export type TelegramMessage = {
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
  new_chat_members?: TelegramUser[];
};

export type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: {
    id: string;
    from: TelegramUser;
    message?: TelegramMessage;
    data?: string;
  };
};

export type TelegramCallbackAnswer = {
  callback_query_id: string;
  text?: string;
};
