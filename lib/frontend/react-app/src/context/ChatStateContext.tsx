import { v4 as uuidv4 } from "uuid";
import React, { createContext, useContext, useEffect, useState } from "react";
import ChatMessage from "../types/ChatMessage";

interface ChatStateValue {
  sessionId: string;
  chatHistory: ChatMessage[];
  invokeModel: (userInput: string) => Promise<void>;
  resetChatHistory: () => void;
  backendStatus: string;
  isLoading: boolean;
}

interface StreamEvent {
  type: "status" | "sql" | "query_result" | "text" | "error" | "done";
  text?: string;
  message?: string;
  sql?: string;
  rowCount?: number;
}

const initialAssistantMessage: ChatMessage = {
  sender: "assistant",
  text: "Hello! How can I assist you today?",
};

export const ChatStateContext = createContext<ChatStateValue | undefined>(
  undefined
);

export const ChatStateContextProvider: React.FC<{
  children: React.ReactNode;
}> = ({ children }) => {
  const [sessionId] = useState(uuidv4());
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([]);
  const [backendStatus, setBackendStatus] = useState("Ready");

  const isLoading = chatHistory.some((message) => message.isLoading);

  useEffect(() => {
    setChatHistory([initialAssistantMessage]);
  }, []);

  const invokeModel = async (userQuery: string) => {
    const apiUrl = import.meta.env.VITE_REST_API_URL;
    const apiKeyValue = import.meta.env.VITE_API_KEY;
    const userMsg: ChatMessage = { sender: "user", text: userQuery };
    const assistantMsg: ChatMessage = {
      sender: "assistant",
      text: "",
      isLoading: true,
      status: "Sending request.",
    };
    const assistantMessageIndex = chatHistory.length + 1;

    setBackendStatus("Working");
    setChatHistory((currentHistory) => [...currentHistory, userMsg, assistantMsg]);

    try {
      const response = await fetch(joinApiPath(apiUrl, "message"), {
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKeyValue,
        },
        body: JSON.stringify({
          sessionId,
          userQuery,
        }),
        method: "POST",
      });

      if (!response.ok) {
        throw new Error(`Request failed with HTTP ${response.status}`);
      }

      await readStreamingResponse(response, assistantMessageIndex);
    } catch (error) {
      updateChatMessage(assistantMessageIndex, {
        isLoading: false,
        status: undefined,
        error: error instanceof Error ? error.message : "Unexpected request failure.",
      });
      setBackendStatus("Error");
    }
  };

  const resetChatHistory = () => {
    setBackendStatus("Ready");
    setChatHistory([initialAssistantMessage]);
  };

  const readStreamingResponse = async (
    response: Response,
    assistantMessageIndex: number
  ) => {
    if (!response.body) {
      throw new Error("Streaming response body was empty.");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bufferedText = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      bufferedText += decoder.decode(value, { stream: true });
      const lines = bufferedText.split("\n");
      bufferedText = lines.pop() ?? "";

      for (const line of lines) {
        handleStreamLine(line, assistantMessageIndex);
      }
    }

    bufferedText += decoder.decode();
    if (bufferedText.trim()) {
      handleStreamLine(bufferedText, assistantMessageIndex);
    }
  };

  const handleStreamLine = (line: string, assistantMessageIndex: number) => {
    const trimmedLine = line.trim();
    if (!trimmedLine) {
      return;
    }

    const event = JSON.parse(trimmedLine) as StreamEvent;

    if (event.type === "status") {
      updateChatMessage(assistantMessageIndex, { status: event.message });
      return;
    }

    if (event.type === "sql" && event.sql) {
      updateChatMessage(assistantMessageIndex, {
        status: "Running Athena query.",
        text: `\`\`\`sql\n${event.sql}\n\`\`\`\n\n`,
      }, true);
      return;
    }

    if (event.type === "query_result") {
      updateChatMessage(assistantMessageIndex, {
        status: `Received ${event.rowCount ?? 0} Athena row(s).`,
      });
      return;
    }

    if (event.type === "text" && event.text) {
      updateChatMessage(assistantMessageIndex, {
        text: event.text,
        status: undefined,
      }, true);
      return;
    }

    if (event.type === "error") {
      updateChatMessage(assistantMessageIndex, {
        isLoading: false,
        status: undefined,
        error: event.message ?? event.text ?? "The backend returned an error.",
      });
      setBackendStatus("Error");
      return;
    }

    if (event.type === "done") {
      updateChatMessage(assistantMessageIndex, {
        isLoading: false,
        status: undefined,
      });
      setBackendStatus("Ready");
    }
  };

  const updateChatMessage = (
    index: number,
    patch: Partial<ChatMessage>,
    appendText = false
  ) => {
    setChatHistory((prevChatHistory) => {
      const existingMessage = prevChatHistory[index];
      if (!existingMessage) {
        return prevChatHistory;
      }

      const nextText = appendText && patch.text
        ? existingMessage.text + patch.text
        : patch.text ?? existingMessage.text;

      const updatedMessage = {
        ...existingMessage,
        ...patch,
        text: nextText,
      };

      return [
        ...prevChatHistory.slice(0, index),
        updatedMessage,
        ...prevChatHistory.slice(index + 1),
      ];
    });
  };

  return (
    <ChatStateContext.Provider
      value={{
        sessionId,
        chatHistory,
        invokeModel,
        resetChatHistory,
        backendStatus,
        isLoading,
      }}
    >
      {children}
    </ChatStateContext.Provider>
  );
};

const joinApiPath = (baseUrl: string, path: string) => {
  const normalizedBaseUrl = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(path, normalizedBaseUrl).toString();
};

// eslint-disable-next-line react-refresh/only-export-components
export const useChatState = () => {
  const context = useContext(ChatStateContext);
  if (context === undefined) {
    throw new Error("useChatState must be used within a ChatStateProvider");
  }
  return context;
};
