import { Boom } from "@hapi/boom";
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";
import pino from "pino";
import qrcode from "qrcode-terminal";
import { FieldValue } from "firebase-admin/firestore";
import { db, isFirebaseConfigured } from "./firebaseAdmin.js";
import { useFirestoreAuthState } from "./firestoreAuthState.js";

const logger = pino({ level: "silent" });

const RECONNECT_DELAY_MS = 5000;
const OWNER_UID = "rHfL5p6hyDbUsTBYQBoh7E4Tavp2";
const COUNTRY_CODE = "55";
const LOCAL_LENGTH = 10;
const LOCAL_WITH_NINTH_DIGIT_LENGTH = 11;

const isFirestoreReady = Boolean(db) && isFirebaseConfigured;

let currentSocket = null;
let reconnectTimer = null;
let isStarting = false;

const clearReconnectTimer = () => {
  if (!reconnectTimer) return;

  clearTimeout(reconnectTimer);
  reconnectTimer = null;
};

const scheduleReconnect = () => {
  if (reconnectTimer) return;

  console.log("Conexao perdida. Tentando reconectar...");

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;

    startWhatsApp().catch((error) => {
      console.error("Falha ao reiniciar a conexao com o WhatsApp:", error);
      scheduleReconnect();
    });
  }, RECONNECT_DELAY_MS);
};

const isGroupJid = (jid = "") => jid.endsWith("@g.us");

const isPnJid = (jid = "") =>
  jid.endsWith("@s.whatsapp.net") || jid.endsWith("@hosted");

const isLidJid = (jid = "") =>
  jid.endsWith("@lid") || jid.endsWith("@hosted.lid");

const digitsOnly = (value = "") => String(value || "").replace(/\D/g, "");

const stripCountryCode = (digits = "") =>
  digits.startsWith(COUNTRY_CODE) ? digits.slice(COUNTRY_CODE.length) : digits;

const removeNinthDigit = (localDigits = "") =>
  localDigits.length === LOCAL_WITH_NINTH_DIGIT_LENGTH
    ? `${localDigits.slice(0, 2)}${localDigits.slice(3)}`
    : localDigits;

const normalizePhoneTo12Digits = (value = "") => {
  const cleaned = digitsOnly(value);
  if (!cleaned) {
    return "";
  }

  const localDigits = removeNinthDigit(stripCountryCode(cleaned));
  if (localDigits.length !== LOCAL_LENGTH) {
    return "";
  }

  return `${COUNTRY_CODE}${localDigits}`;
};

const normalizePhone = (jid = "") => {
  if (!jid || (!isPnJid(jid) && !/^\d+$/.test(jid))) {
    return "";
  }

  const normalizedJid = jid.includes("@") ? jid.replace(/:\d+@/, "@") : jid;
  const phone = normalizedJid.split("@")[0];

  return normalizePhoneTo12Digits(phone);
};

const getMessageText = (messageContent) => {
  if (!messageContent) return "";

  if (messageContent.conversation) return messageContent.conversation;

  if (messageContent.extendedTextMessage?.text)
    return messageContent.extendedTextMessage.text;

  if (messageContent.imageMessage?.caption)
    return messageContent.imageMessage.caption;

  if (messageContent.ephemeralMessage?.message)
    return getMessageText(messageContent.ephemeralMessage.message);

  if (messageContent.viewOnceMessage?.message)
    return getMessageText(messageContent.viewOnceMessage.message);

  if (messageContent.viewOnceMessageV2?.message)
    return getMessageText(messageContent.viewOnceMessageV2.message);

  if (messageContent.viewOnceMessageV2Extension?.message)
    return getMessageText(messageContent.viewOnceMessageV2Extension.message);

  return "";
};

const logIncomingMessage = ({ phone, text }) => {
  console.log("Nova mensagem recebida");
  console.log(`Numero: ${phone}`);
  console.log(`Mensagem: ${text}`);
  console.log("");
};

const normalizeDisplayName = (value = "") =>
  String(value || "")
    .trim()
    .replace(/\s+/g, " ");

const buildUnknownContactLabel = ({ displayName, phone }) => {
  const nomeBase = normalizeDisplayName(displayName) || phone;
  return `${nomeBase} (Novo numero)`;
};

const isFailedPreconditionError = (error) => error?.code === 9;

const tryGetQuerySnapshot = async (query, queryLabel) => {
  try {
    return await query.get();
  } catch (error) {
    if (!isFailedPreconditionError(error)) {
      throw error;
    }

    console.warn(
      `Consulta Firestore ignorada por indice ausente (${queryLabel}).`
    );
    return null;
  }
};

const getChamadosCollection = () =>
  db.collection("users").doc(OWNER_UID).collection("chamados");

const findChamadoAberto = async ({ nomeEmpresa, nomeFuncionario }) => {
  if (!db) {
    return null;
  }

  return getChamadosCollection()
    .where("empresa", "==", nomeEmpresa)
    .where("funcionario", "==", nomeFuncionario)
    .where("status", "==", "aberto")
    .limit(1)
    .get();
};

const findChamadoAbertoByPhone = async (phone) => {
  if (!db || !phone) {
    return null;
  }

  const snapshot = await getChamadosCollection()
    .where("telefoneOrigem", "==", phone)
    .get();

  return snapshot.docs.find((doc) => doc.data()?.status === "aberto") ?? null;
};

const createChamado = async ({
  empresaId = "",
  nomeEmpresa = "",
  funcionarioId = "",
  nomeFuncionario = "",
  nomeCliente = "",
  telefoneOrigem = "",
}) => {
  if (!db) {
    return null;
  }

  const clienteNome = nomeCliente || nomeEmpresa || "";

  return getChamadosCollection().add({
    cliente: clienteNome,
    clienteNome,
    empresa: nomeEmpresa,
    empresaId,
    funcionario: nomeFuncionario,
    funcionarioId,
    motivo: "",
    status: "aberto",
    origem: "whatsapp",
    telefoneOrigem,
    tempoAtendimento: null,
    dataFechamento: null,
    data: FieldValue.serverTimestamp(),
    tipoCadastro: "novo",
  });
};

const findFuncionarioByPhone = async (phone) => {
  if (!db || !phone) {
    return null;
  }

  const telefone = normalizePhoneTo12Digits(phone);
  if (!telefone) {
    return null;
  }

  const telefoneSnapshot = await tryGetQuerySnapshot(
    db
      .collectionGroup("funcionarios")
      .where("telefone", "==", telefone)
      .limit(1),
    "funcionarios.telefone"
  );

  if (telefoneSnapshot && !telefoneSnapshot.empty) {
    const funcionarioDoc = telefoneSnapshot.docs[0];
    const funcionarioData = funcionarioDoc.data();
    const nomeFuncionario = funcionarioData.nomeFuncionario || "Sem nome";
    const empresaRef = funcionarioDoc.ref.parent.parent;

    if (!empresaRef) {
      return null;
    }

    const empresaId = funcionarioDoc.ref.parent.parent.id;
    const empresaDoc = await empresaRef.get();

    return {
      funcionarioId: funcionarioDoc.id,
      funcionarioData,
      criarChamadoAutomatico: funcionarioData.criarChamadoAutomatico,
      nomeFuncionario,
      empresaId,
      empresaData: empresaDoc.data(),
    };
  }

  const telefoneBuscaSnapshot = await tryGetQuerySnapshot(
    db
      .collectionGroup("funcionarios")
      .where("telefoneBusca", "==", telefone)
      .limit(1),
    "funcionarios.telefoneBusca"
  );

  const snapshot = telefoneBuscaSnapshot;

  if (!snapshot || snapshot.empty) {
    return null;
  }

  const funcionarioDoc = snapshot.docs[0];
  const funcionarioData = funcionarioDoc.data();
  const nomeFuncionario = funcionarioData.nomeFuncionario || "Sem nome";
  const empresaRef = funcionarioDoc.ref.parent.parent;

  if (!empresaRef) {
    return null;
  }

  const empresaId = funcionarioDoc.ref.parent.parent.id;
  const empresaDoc = await empresaRef.get();

  return {
    funcionarioId: funcionarioDoc.id,
    funcionarioData,
    criarChamadoAutomatico: funcionarioData.criarChamadoAutomatico,
    nomeFuncionario,
    empresaId,
    empresaData: empresaDoc.data(),
  };
};

const getDisconnectCode = (lastDisconnect) => {
  const error = lastDisconnect?.error;

  if (error instanceof Boom) {
    return error.output?.statusCode;
  }

  return error?.output?.statusCode;
};

const resolvePnJid = async (sock, jid = "") => {
  if (!jid) {
    return "";
  }

  if (isPnJid(jid)) {
    return jid;
  }

  if (!isLidJid(jid)) {
    return "";
  }

  return (await sock.signalRepository.lidMapping.getPNForLID(jid)) ?? "";
};

const resolveSender = async (sock, msg) => {
  const remoteJid = msg.key?.remoteJid ?? "";
  const remoteJidAlt = msg.key?.remoteJidAlt ?? "";

  // Em conversas LID, o Baileys pode entregar o PN em remoteJidAlt ou no store interno de mapeamento.
  const pnJid =
    (isPnJid(remoteJidAlt) && remoteJidAlt) ||
    (isPnJid(remoteJid) && remoteJid) ||
    (await resolvePnJid(sock, remoteJidAlt)) ||
    (await resolvePnJid(sock, remoteJid));

  return {
    phone: normalizePhone(pnJid),
    senderJid: pnJid || remoteJidAlt || remoteJid,
    remoteJid,
    remoteJidAlt,
  };
};

const handleMessagesUpsert = async (sock, event) => {
  const { messages, type } = event;

  if (type !== "notify") return;

  for (const msg of messages) {
    const remoteJid = msg.key?.remoteJid ?? "";

    if (!remoteJid || remoteJid === "status@broadcast") continue;

    if (msg.key?.fromMe === true) continue;

    if (isGroupJid(remoteJid)) continue;

    const text = getMessageText(msg.message).trim();
    const sender = await resolveSender(sock, msg);

    if (!text) continue;

    if (!sender.phone) {
      console.warn("Mensagem recebida sem mapeamento do telefone real.");
      console.warn(`JID original: ${sender.remoteJid}`);

      if (sender.remoteJidAlt && sender.remoteJidAlt !== sender.remoteJid) {
        console.warn(`JID alternativo: ${sender.remoteJidAlt}`);
      }

      console.warn(`Mensagem: ${text}`);
      console.log("");
      continue;
    }

    logIncomingMessage({ phone: sender.phone, text });

    const funcionario = await findFuncionarioByPhone(sender.phone);

    if (!funcionario) {
      const nomeContato = buildUnknownContactLabel({
        displayName: msg.pushName,
        phone: sender.phone,
      });
      const chamadoExistente = await findChamadoAbertoByPhone(sender.phone);

      if (chamadoExistente) {
        console.log("Chamado ja existente para numero desconhecido, nova mensagem ignorada");
        console.log(`Contato: ${nomeContato}`);
        console.log(`Numero: ${sender.phone}`);
        console.log("");
        continue;
      }

      await createChamado({
        nomeCliente: nomeContato,
        telefoneOrigem: sender.phone,
      });

      console.log("Chamado criado para numero desconhecido");
      console.log(`Contato: ${nomeContato}`);
      console.log(`Numero: ${sender.phone}`);
      console.log("");
      continue;
    }

    console.log("Funcionario encontrado");
    console.log(`Nome: ${funcionario.nomeFuncionario}`);
    console.log(`Empresa: ${funcionario.empresaData.nomeEmpresa ?? "Sem nome"}`);
    console.log(`FuncionarioId: ${funcionario.funcionarioId}`);
    console.log(`EmpresaId: ${funcionario.empresaId}`);
    console.log("");

    console.log("VALOR DO CAMPO:", funcionario.criarChamadoAutomatico);

    if (
      funcionario.criarChamadoAutomatico === false ||
      funcionario.criarChamadoAutomatico === "false"
    ) {
      console.log(
        `\u{1F6AB} Chamado bloqueado para ${funcionario.nomeFuncionario}`
      );
      console.log("");
      continue;
    }

    const nomeEmpresa =
      funcionario.empresaData?.nomeEmpresa || "Empresa nao identificada";
    const chamadoExistente = await findChamadoAberto({
      nomeEmpresa,
      nomeFuncionario: funcionario.nomeFuncionario,
    });

    if (chamadoExistente && !chamadoExistente.empty) {
      console.log("Chamado ja existente, nova mensagem ignorada");
      console.log(`Empresa: ${nomeEmpresa}`);
      console.log(`Funcionario: ${funcionario.nomeFuncionario}`);
      console.log("");
      continue;
    }

    await createChamado({
      empresaId: funcionario.empresaId,
      funcionarioId: funcionario.funcionarioId,
      nomeEmpresa,
      nomeFuncionario: funcionario.nomeFuncionario,
      telefoneOrigem: sender.phone,
    });

    console.log("Chamado criado com sucesso");
    console.log(`Empresa: ${nomeEmpresa}`);
    console.log(`Funcionario: ${funcionario.nomeFuncionario}`);
    console.log("");
  }
};

const handleConnectionUpdate = (sock, update) => {
  if (sock !== currentSocket) return;

  const { connection, lastDisconnect, qr } = update;

  if (qr) {
    console.log("QR Code gerado. Escaneie com o WhatsApp para conectar.");
    qrcode.generate(qr, { small: true });
  }

  if (connection === "open") {
    clearReconnectTimer();

    console.log("WhatsApp conectado com sucesso.");
    console.log(
      `Firestore: ${isFirestoreReady ? "configurado" : "desabilitado"}`
    );
    console.log("Servidor pronto para receber mensagens.\n");

    return;
  }

  if (connection !== "close") return;

  currentSocket = null;

  const statusCode = getDisconnectCode(lastDisconnect);
  const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

  console.error(`Conexao encerrada. Codigo: ${statusCode ?? "desconhecido"}`);

  if (shouldReconnect) {
    scheduleReconnect();
    return;
  }

  console.error(
    "Logout detectado. Escaneie o QR Code novamente para autenticar."
  );
};

async function startWhatsApp() {
  if (isStarting) return;

  isStarting = true;

  try {
    clearReconnectTimer();

    console.log("Iniciando servidor WhatsApp...");

    const { version, isLatest, error } = await fetchLatestBaileysVersion();

    if (error) {
      console.warn("Nao foi possivel confirmar versao mais recente do Baileys.");
    }

    console.log(
      `Versao WhatsApp Web: ${version.join(".")} ${
        isLatest ? "(latest)" : "(fallback)"
      }`
    );

    const { state, saveCreds } = await useFirestoreAuthState();

    const sock = makeWASocket({
      version,
      auth: state,
      logger,
      browser: Browsers.windows("Chrome"),
    });

    currentSocket = sock;

    sock.ev.on("creds.update", () => {
      saveCreds().catch(() => {});
    });

    sock.ev.on("connection.update", (update) =>
      handleConnectionUpdate(sock, update)
    );

    sock.ev.on("messages.upsert", (event) => {
      handleMessagesUpsert(sock, event).catch((error) => {
        console.error("Falha ao processar mensagens recebidas:", error);
      });
    });
  } finally {
    isStarting = false;
  }
}

startWhatsApp().catch((error) => {
  console.error("Erro ao iniciar servidor WhatsApp:", error);
  process.exit(1);
});

import http from "http";

const PORT = process.env.PORT || 3000;

http
  .createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("WhatsApp server rodando");
  })
  .listen(PORT, () => {
    console.log("Servidor rodando na porta", PORT);
  });
