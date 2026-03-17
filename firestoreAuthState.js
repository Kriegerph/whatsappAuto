import {
  BufferJSON,
  initAuthCreds,
  proto,
} from "@whiskeysockets/baileys";
import { FieldValue } from "firebase-admin/firestore";
import { db } from "./firebaseAdmin.js";

const SESSION_COLLECTION = "sessions";
const SESSION_DOCUMENT = "whatsapp";

const getSessionRef = () => db?.collection(SESSION_COLLECTION).doc(SESSION_DOCUMENT);

const serializeData = (value) => JSON.parse(JSON.stringify(value, BufferJSON.replacer));

const deserializeData = (value) => {
  if (typeof value === "undefined") {
    return undefined;
  }

  return JSON.parse(JSON.stringify(value), BufferJSON.reviver);
};

const restoreCreds = (storedCreds) => {
  if (!storedCreds) {
    return initAuthCreds();
  }

  const baseCreds = initAuthCreds();
  const restoredCreds = deserializeData(storedCreds);

  return {
    ...baseCreds,
    ...restoredCreds,
    accountSettings: {
      ...baseCreds.accountSettings,
      ...restoredCreds.accountSettings,
    },
  };
};

const restoreKeys = (storedKeys) => deserializeData(storedKeys) ?? {};

export async function useFirestoreAuthState() {
  console.log("Iniciando carregamento da sessao do Firestore...");

  let creds = initAuthCreds();
  let keysData = {};

  try {
    if (!db) {
      throw new Error("Firestore nao configurado.");
    }

    const sessionSnapshot = await getSessionRef().get();

    if (sessionSnapshot.exists) {
      const sessionData = sessionSnapshot.data() ?? {};

      creds = restoreCreds(sessionData.creds);
      keysData = restoreKeys(sessionData.keys);

      console.log("Sessao encontrada no Firestore.");
    } else {
      console.log("Sessao nao encontrada, aguardando QR Code.");
    }
  } catch (error) {
    console.error("Erro ao carregar sessao do Firestore:", error);
  }

  let writeQueue = Promise.resolve();

  const persistState = async () => {
    if (!db) {
      const error = new Error("Firestore nao configurado.");
      console.error("Erro ao salvar sessao do Firestore:", error);
      throw error;
    }

    await getSessionRef().set({
      creds: serializeData(creds),
      keys: serializeData(keysData),
      updatedAt: FieldValue.serverTimestamp(),
    });

    console.log("Sessao do WhatsApp atualizada no Firestore.");
  };

  const enqueuePersist = () => {
    const writeTask = async () => persistState();
    const pendingWrite = writeQueue.then(writeTask, writeTask);

    writeQueue = pendingWrite.catch(() => {});

    return pendingWrite;
  };

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const category = keysData[type] ?? {};
          const result = {};

          for (const id of ids) {
            let value = category[id];

            if (typeof value === "undefined" || value === null) {
              continue;
            }

            if (type === "app-state-sync-key") {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }

            result[id] = value;
          }

          return result;
        },
        set: async (data) => {
          for (const category of Object.keys(data)) {
            keysData[category] ??= {};

            for (const id of Object.keys(data[category])) {
              const value = data[category][id];

              if (value) {
                keysData[category][id] = value;
              } else {
                delete keysData[category][id];
              }
            }

            if (Object.keys(keysData[category]).length === 0) {
              delete keysData[category];
            }
          }

          await enqueuePersist();
        },
      },
    },
    saveCreds: enqueuePersist,
  };
}
