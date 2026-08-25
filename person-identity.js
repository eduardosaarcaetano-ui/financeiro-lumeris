"use strict";

(function exposePersonIdentity(root, factory) {
 const api = factory();
 if (typeof module === "object" && module.exports) module.exports = api;
 if (root) root.LumerisPersonIdentity = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createPersonIdentityApi() {
 const PERSON_REFERENCE_FIELDS = new Set(["personId", "customerId", "supplierId", "primarySupplierId"]);

 function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
 }

 function normalizeName(value) {
  return String(value || "")
   .normalize("NFD")
   .replace(/[\u0300-\u036f]/g, "")
   .toLocaleLowerCase("pt-BR")
   .trim()
   .replace(/\s+/g, " ");
 }

 function normalizeDocument(value) {
  return String(value || "").replace(/\D/g, "");
 }

 function mergePersonType(currentType, incomingType) {
  const types = new Set([currentType, incomingType].filter(Boolean));
  if (types.has("ambos") || (types.has("cliente") && types.has("fornecedor"))) return "ambos";
  return currentType || incomingType || "cliente";
 }

 function findMatchingPerson(people, candidate, { excludeId = "" } = {}) {
  const list = Array.isArray(people) ? people : [];
  const nameKey = normalizeName(candidate?.name);
  const documentKey = normalizeDocument(candidate?.document);
  const eligible = list.filter((person) => String(person?.id || "") !== String(excludeId || ""));
  const documentMatch = documentKey
   ? eligible.find((person) => normalizeDocument(person?.document) === documentKey)
   : null;
  if (documentMatch) return { person: documentMatch, matchedBy: "document", conflict: null };

  const nameMatches = nameKey
   ? eligible.filter((person) => normalizeName(person?.name) === nameKey)
   : [];
  if (!nameMatches.length) return { person: null, matchedBy: "", conflict: null };

  const conflicting = nameMatches.find((person) => {
   const existingDocument = normalizeDocument(person?.document);
   return documentKey && existingDocument && existingDocument !== documentKey;
  });
  if (conflicting) {
   return {
    person: null,
    matchedBy: "name",
    conflict: {
     reason: "same_name_different_document",
     existingId: conflicting.id,
     name: conflicting.name,
    },
   };
  }
  return { person: nameMatches[0], matchedBy: "name", conflict: null };
 }

 function mergePersonRecords(current, incoming) {
  const merged = { ...clone(current || {}) };
  const candidate = clone(incoming || {});
  merged.id = current?.id || candidate.id;
  merged.type = mergePersonType(current?.type, candidate.type);
  merged.name = current?.name || candidate.name || "";
  merged.document = current?.document || candidate.document || "";
  merged.contact = current?.contact || candidate.contact || "";
  merged.createdAt = current?.createdAt || candidate.createdAt || "";
  merged.updatedAt = [current?.updatedAt, candidate.updatedAt].filter(Boolean).sort().pop() || "";
  merged.importSource = current?.importSource || candidate.importSource || "";
  return merged;
 }

 function isContractDraftClientId(path) {
  return path.length >= 3
   && path[path.length - 3] === "contractDraft"
   && path[path.length - 2] === "client"
   && path[path.length - 1] === "id";
 }

 function remapPersonReferences(value, aliases, path = []) {
  if (Array.isArray(value)) {
   value.forEach((item, index) => remapPersonReferences(item, aliases, [...path, index]));
   return value;
  }
  if (!value || typeof value !== "object") return value;
  Object.entries(value).forEach(([key, child]) => {
   const nextPath = [...path, key];
   if (typeof child === "string" && (PERSON_REFERENCE_FIELDS.has(key) || isContractDraftClientId(nextPath))) {
    const canonicalId = aliases.get(child);
    if (canonicalId) value[key] = canonicalId;
    return;
   }
   remapPersonReferences(child, aliases, nextPath);
  });
  return value;
 }

 function collectReferenceCounts(state) {
  const ids = new Set((state.people || []).map((person) => String(person?.id || "")).filter(Boolean));
  const counts = new Map([...ids].map((id) => [id, 0]));
  const visit = (value, path = []) => {
   if (Array.isArray(value)) {
    value.forEach((item, index) => visit(item, [...path, index]));
    return;
   }
   if (!value || typeof value !== "object") return;
   Object.entries(value).forEach(([key, child]) => {
    const nextPath = [...path, key];
    if (typeof child === "string" && ids.has(child) && (PERSON_REFERENCE_FIELDS.has(key) || isContractDraftClientId(nextPath))) {
     counts.set(child, (counts.get(child) || 0) + 1);
    } else {
     visit(child, nextPath);
    }
   });
  };
  Object.entries(state).forEach(([key, value]) => {
   if (key !== "people") visit(value, [key]);
  });
  return counts;
 }

 function canonicalScore(person, referenceCounts) {
  return (normalizeDocument(person?.document) ? 100000 : 0)
   + (String(person?.contact || "").trim() ? 10000 : 0)
   + ((referenceCounts.get(String(person?.id || "")) || 0) * 100)
   + (person?.createdAt ? 10 : 0);
 }

 function chooseCanonical(records, referenceCounts) {
  return [...records].sort((left, right) => {
   const scoreDifference = canonicalScore(right, referenceCounts) - canonicalScore(left, referenceCounts);
   if (scoreDifference) return scoreDifference;
   const leftCreated = String(left?.createdAt || "9999");
   const rightCreated = String(right?.createdAt || "9999");
   if (leftCreated !== rightCreated) return leftCreated.localeCompare(rightCreated);
   return String(left?.id || "").localeCompare(String(right?.id || ""));
  })[0];
 }

 function chooseDisplayName(records, fallback) {
  const normalizedNames = new Set(records.map((record) => normalizeName(record?.name)).filter(Boolean));
  if (normalizedNames.size !== 1) return fallback || records[0]?.name || "";
  return [...records].sort((left, right) => {
   const score = (record) => {
    const name = String(record?.name || "").trim();
    const letters = name.replace(/[^A-Za-zÀ-ÖØ-öø-ÿ]/g, "");
    const mixedCase = /[a-zà-öø-ÿ]/.test(letters) && /[A-ZÀ-ÖØ-Þ]/.test(letters);
    const hasAccent = name.normalize("NFD") !== name.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    return (mixedCase ? 1000 : 0) + (hasAccent ? 100 : 0) + name.length;
   };
   return score(right) - score(left);
  })[0]?.name || fallback || "";
 }

 function unionFind(size) {
  const parent = Array.from({ length: size }, (_, index) => index);
  const find = (index) => {
   if (parent[index] !== index) parent[index] = find(parent[index]);
   return parent[index];
  };
  const union = (left, right) => {
   const a = find(left);
   const b = find(right);
   if (a !== b) parent[b] = a;
  };
  return { find, union };
 }

 function consolidatePeopleState(inputState, { mergedAt = "" } = {}) {
  const state = clone(inputState || {});
  const people = Array.isArray(state.people) ? state.people : [];
  const referenceCounts = collectReferenceCounts(state);
  const uf = unionFind(people.length);
  const byDocument = new Map();
  const byName = new Map();

  people.forEach((person, index) => {
   const documentKey = normalizeDocument(person?.document);
   const nameKey = normalizeName(person?.name);
   if (documentKey) {
    if (byDocument.has(documentKey)) uf.union(index, byDocument.get(documentKey));
    else byDocument.set(documentKey, index);
   }
   if (nameKey) {
    if (!byName.has(nameKey)) byName.set(nameKey, []);
    byName.get(nameKey).push(index);
   }
  });

  const conflicts = [];
  byName.forEach((indices, nameKey) => {
   if (indices.length < 2) return;
   const documents = new Set(indices.map((index) => normalizeDocument(people[index]?.document)).filter(Boolean));
   if (documents.size > 1) {
    conflicts.push({
     reason: "same_name_different_document",
     name: people[indices[0]]?.name || nameKey,
     recordIds: indices.map((index) => people[index]?.id),
    });
    return;
   }
   indices.slice(1).forEach((index) => uf.union(indices[0], index));
  });

  const groups = new Map();
  people.forEach((person, index) => {
   const root = uf.find(index);
   if (!groups.has(root)) groups.set(root, []);
   groups.get(root).push(person);
  });

  const aliases = new Map();
  const consolidatedPeople = [];
  const merges = [];
  groups.forEach((records) => {
   if (records.length === 1) {
    consolidatedPeople.push(records[0]);
    return;
   }
   const canonical = chooseCanonical(records, referenceCounts);
   let merged = clone(canonical);
   const mergedRecords = [];
   records.forEach((record) => {
    if (record.id === canonical.id) return;
    aliases.set(String(record.id), String(canonical.id));
    merged = mergePersonRecords(merged, record);
    mergedRecords.push(...(Array.isArray(record.mergedRecords) ? record.mergedRecords : []), clone(record));
   });
   merged.name = chooseDisplayName(records, merged.name);
   const previousMergedRecords = Array.isArray(canonical.mergedRecords) ? canonical.mergedRecords : [];
   merged.mergedRecords = [...previousMergedRecords, ...mergedRecords];
   merged.mergedFromIds = [...new Set([
    ...(Array.isArray(canonical.mergedFromIds) ? canonical.mergedFromIds : []),
    ...records.filter((record) => record.id !== canonical.id).map((record) => record.id),
   ])];
   if (mergedAt) merged.lastIdentityMergeAt = mergedAt;
   consolidatedPeople.push(merged);
   merges.push({
    canonicalId: canonical.id,
    name: canonical.name,
    mergedIds: records.filter((record) => record.id !== canonical.id).map((record) => record.id),
    referencesMoved: records
     .filter((record) => record.id !== canonical.id)
     .reduce((total, record) => total + (referenceCounts.get(String(record.id)) || 0), 0),
   });
  });

  state.people = consolidatedPeople;
  Object.entries(state).forEach(([key, value]) => {
   if (key !== "people") remapPersonReferences(value, aliases, [key]);
  });

  const peopleByName = new Map();
  state.people.forEach((person) => {
   const key = normalizeName(person?.name);
   if (key && !peopleByName.has(key)) peopleByName.set(key, person);
  });
  (state.salesRankingEntries || []).forEach((entry) => {
   if (entry.personId || !entry.client) return;
   const person = peopleByName.get(normalizeName(entry.client));
   if (person) entry.personId = person.id;
  });

  return {
   state,
   aliases: Object.fromEntries(aliases),
   report: {
    peopleBefore: people.length,
    peopleAfter: consolidatedPeople.length,
    mergedRecords: aliases.size,
    mergedGroups: merges.length,
    conflicts,
    merges,
   },
  };
 }

 return {
  PERSON_REFERENCE_FIELDS,
  normalizeName,
  normalizeDocument,
  mergePersonType,
  findMatchingPerson,
  mergePersonRecords,
  remapPersonReferences,
  consolidatePeopleState,
 };
});
