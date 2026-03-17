import { existsSync, readFileSync } from 'node:fs';
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

const loadServiceAccount = () => {
  if (!existsSync(serviceAccountPath)) {
    console.warn('Arquivo firebase-service-account.json nao encontrado. Firestore desabilitado.');
    return null;
  }

  try {
    const fileContent = readFileSync(serviceAccountPath, 'utf8');
    const parsedContent = JSON.parse(fileContent);

    if (!isValidServiceAccount(parsedContent)) {
      console.warn('firebase-service-account.json ainda esta com dados placeholder. Firestore desabilitado.');
      return null;
    }

    return parsedContent;
  } catch (error) {
    console.error('Falha ao carregar firebase-service-account.json:', error.message);
    return null;
  }
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
