import { BigQuery } from "@google-cloud/bigquery";

let cached;

/**
 * Return a cached BigQuery client.
 *
 * @returns {BigQuery}
 *
 * @example
 *   const bq = getBigQueryClient();
 *   const [rows] = await bq.query({ query, params });
 */
export function getBigQueryClient() {
  if (!cached) {
    cached = new BigQuery({
      projectId: process.env.BQ_PROJECT_ID,
      location: process.env.BQ_LOCATION ?? "europe-west3"
    });
  }
  return cached;
}

/**
 * Build a fully qualified table identifier for SQL.
 *
 * @param {string} tableName
 * @returns {string} `project.dataset.table`
 */
export function bqTable(tableName) {
  const project = process.env.BQ_PROJECT_ID;
  const dataset = process.env.BQ_DATASET ?? "kickwise_main";
  return `${project}.${dataset}.${tableName}`;
}
