import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const serviceAccountPath = new URL('./firebase-service-account.json', import.meta.url);

const isValidServiceAccount = (serviceAccount) => {
  const requiredFields = ['project_id', 'client_email', 'private_key'];

  return requiredFields.every((field) => {
    const value = serviceAccount?.[field];

    return typeof value === 'string' && value.trim() !== '' && !value.includes('SUBSTITUIR');
  });
};

const normalizePrivateKey = (privateKey = '') => privateKey.replace(/\\n/g, '\n');

const parseServiceAccountJson = (value, sourceLabel) => {
  try {
    const serviceAccount = JSON.parse(value);

    return {
      ...serviceAccount,
      private_key: normalizePrivateKey(serviceAccount.private_key)
    };
  } catch (error) {
    console.error(`Falha ao carregar credencial Firebase de ${sourceLabel}:`, error.message);
    return null;
  }
};

const loadServiceAccountFromFile = (pathOrUrl, sourceLabel) => {
  const filePath = pathOrUrl instanceof URL ? fileURLToPath(pathOrUrl) : pathOrUrl;

  if (!existsSync(filePath)) {
    console.warn(`${sourceLabel} nao encontrado. Firestore desabilitado.`);
    return null;
  }

  try {
    const fileContent = readFileSync(filePath, 'utf8');
    return parseServiceAccountJson(fileContent, sourceLabel);
  } catch (error) {
    console.error(`Falha ao carregar ${sourceLabel}:`, error.message);
    return null;
  }
};

const loadServiceAccountFromEnv = () => {
  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim();
  if (serviceAccountJson) {
    return parseServiceAccountJson(serviceAccountJson, 'FIREBASE_SERVICE_ACCOUNT_JSON');
  }

  const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  if (credentialsPath) {
    return loadServiceAccountFromFile(credentialsPath, 'GOOGLE_APPLICATION_CREDENTIALS');
  }

  const projectId = process.env.FIREBASE_PROJECT_ID?.trim();
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL?.trim();
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.trim();

  if (!projectId && !clientEmail && !privateKey) {
    return null;
  }

  return {
    project_id: projectId,
    client_email: clientEmail,
    private_key: normalizePrivateKey(privateKey)
  };
};

const loadServiceAccount = () => {
  const envServiceAccount = loadServiceAccountFromEnv();

  if (envServiceAccount) {
    if (!isValidServiceAccount(envServiceAccount)) {
      console.warn('Credencial Firebase das variaveis de ambiente esta incompleta. Firestore desabilitado.');
      return null;
    }

    console.log('Credencial Firebase carregada das variaveis de ambiente.');
    return envServiceAccount;
  }

  const fileServiceAccount = loadServiceAccountFromFile(
    serviceAccountPath,
    'firebase-service-account.json'
  );

  if (!fileServiceAccount) {
    return null;
  }

  if (!isValidServiceAccount(fileServiceAccount)) {
    console.warn('firebase-service-account.json ainda esta com dados placeholder. Firestore desabilitado.');
    return null;
  }

  return fileServiceAccount;
};

const serviceAccount = loadServiceAccount();

if (serviceAccount && getApps().length === 0) {
  initializeApp({
    credential: cert(serviceAccount),
  });
}

const db = serviceAccount ? getFirestore() : null;

export { db };
export const isFirebaseConfigured = Boolean(db);
