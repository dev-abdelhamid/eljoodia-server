/**
 * Localizes the data based on the specified language and translatable fields.
 * @param {Object} data - The data object to localize (e.g., product, branch, user).
 * @param {string} lang - The language code ('ar' or 'en').
 * @param {string[]} translatableFields - Array of field names that may have translations (e.g., ['name', 'description']).
 * @returns {Object} - The localized data object.
 */
const localizeData = (data, lang = 'en', translatableFields = []) => {
  const langCode = lang === 'ar' ? 'ar' : 'en';
  const localizedData = { ...data.toObject ? data.toObject() : data };

  translatableFields.forEach((field) => {
    if (localizedData[field]) {
      if (typeof localizedData[field] === 'string') {
        // For old data (single string), return as is
        localizedData[field] = localizedData[field];
      } else if (localizedData[field][langCode]) {
        // For new data (object with ar/en), return the translated field
        localizedData[field] = localizedData[field][langCode];
      } else {
        // Fallback to the other language if the requested one is missing
        localizedData[field] = localizedData[field].ar || localizedData[field].en || '';
      }
    }
  });

  return localizedData;
};

module.exports = { localizeData };