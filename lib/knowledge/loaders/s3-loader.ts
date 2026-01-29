import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import { Document } from '@langchain/core/documents';
import { TextLoader } from '@langchain/classic/document_loaders/fs/text';
import { PDFLoader } from '@langchain/community/document_loaders/fs/pdf';
import { CSVLoader } from '@langchain/community/document_loaders/fs/csv';
import { JSONLoader } from '@langchain/classic/document_loaders/fs/json';
import { Readable } from 'stream';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { minimatch } from 'minimatch';
import type { S3SourceConfig } from '../types.js';
import { detectFileType, isSupportedFileType } from '../utils/file-type-detector.js';
import { createLogger } from '../../logger.js';

const logger = createLogger('S3Loader');

/**
 * S3 document loader supporting AWS S3 and S3-compatible services (MinIO, Wasabi, etc.).
 * Downloads files to temporary storage and uses appropriate loaders based on file type.
 */
export class S3Loader {
  private config: S3SourceConfig;
  private s3Client: S3Client;

  constructor(config: S3SourceConfig) {
    this.config = config;

    // Configure S3 client
    const clientConfig: any = {
      region: config.region,
      forcePathStyle: config.forcePathStyle,
    };

    // Use custom endpoint if provided (for MinIO, Wasabi, etc.)
    if (config.endpoint) {
      clientConfig.endpoint = config.endpoint;
      logger.info(`Using custom S3 endpoint: ${config.endpoint}`);
    }

    // Use credentials if provided, otherwise fall back to environment variables
    if (config.accessKeyId && config.secretAccessKey) {
      clientConfig.credentials = {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      };
    }

    this.s3Client = new S3Client(clientConfig);
  }

  async load(): Promise<Document[]> {
    const { bucket, prefix, pattern } = this.config;

    logger.info(`Loading documents from S3 bucket: ${bucket}`);
    if (prefix) {
      logger.info(`Using prefix: ${prefix}`);
    }
    if (pattern) {
      logger.info(`Filtering with pattern: ${pattern}`);
    }

    try {
      // List objects
      const keys = await this.listObjects();
      logger.info(`Found ${keys.length} object(s) in bucket`);

      // Filter by pattern if specified
      const filteredKeys = pattern
        ? keys.filter((key) => minimatch(key, pattern))
        : keys;

      logger.info(`Processing ${filteredKeys.length} file(s) after pattern filtering`);

      // Filter out unsupported file types
      const supportedKeys = filteredKeys.filter((key) => {
        const supported = isSupportedFileType(key);
        if (!supported) {
          logger.warn(`Skipping unsupported file type: ${key}`);
        }
        return supported;
      });

      if (supportedKeys.length === 0) {
        logger.warn(`No supported files found in S3 bucket`);
        return [];
      }

      logger.info(`Loading ${supportedKeys.length} supported file(s)`);

      // Load documents from each file
      const allDocs: Document[] = [];
      for (const key of supportedKeys) {
        try {
          const docs = await this.loadFile(key);
          allDocs.push(...docs);
          logger.info(`Loaded ${docs.length} document(s) from ${key}`);
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          logger.error(`Failed to load ${key}: ${errorMessage}`);
          // Continue with other files
        }
      }

      logger.info(`Loaded total of ${allDocs.length} document(s) from S3`);
      return allDocs;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`S3 loading failed: ${errorMessage}`);
      throw new Error(`Failed to load documents from S3: ${errorMessage}`);
    }
  }

  private async listObjects(): Promise<string[]> {
    const keys: string[] = [];
    let continuationToken: string | undefined;

    do {
      const command = new ListObjectsV2Command({
        Bucket: this.config.bucket,
        Prefix: this.config.prefix,
        ContinuationToken: continuationToken,
      });

      const response = await this.s3Client.send(command);

      if (response.Contents) {
        for (const obj of response.Contents) {
          if (obj.Key) {
            // Skip directories (keys ending with /)
            if (!obj.Key.endsWith('/')) {
              keys.push(obj.Key);
            }
          }
        }
      }

      continuationToken = response.NextContinuationToken;
    } while (continuationToken);

    return keys;
  }

  private async loadFile(key: string): Promise<Document[]> {
    // Download file to temporary location
    const tmpFile = await this.downloadToTemp(key);

    try {
      // Detect file type and create appropriate loader
      const fileType = detectFileType(key);
      const loader = this.createLoader(fileType, tmpFile);

      // Load documents
      const docs = await loader.load();

      // Add S3 metadata to all documents
      docs.forEach((doc) => {
        doc.metadata.s3_bucket = this.config.bucket;
        doc.metadata.s3_key = key;
        doc.metadata.source = `s3://${this.config.bucket}/${key}`;
      });

      return docs;
    } finally {
      // Clean up temporary file
      try {
        fs.unlinkSync(tmpFile);
      } catch (error) {
        logger.warn(`Failed to delete temporary file ${tmpFile}: ${error}`);
      }
    }
  }

  private async downloadToTemp(key: string): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.config.bucket,
      Key: key,
    });

    const response = await this.s3Client.send(command);

    if (!response.Body) {
      throw new Error(`No body in S3 response for key: ${key}`);
    }

    // Create temporary file
    const ext = path.extname(key);
    const tmpFile = path.join(os.tmpdir(), `s3-loader-${Date.now()}-${Math.random().toString(36).substring(7)}${ext}`);

    // Stream to file
    const stream = response.Body as Readable;
    const writeStream = fs.createWriteStream(tmpFile);

    await new Promise<void>((resolve, reject) => {
      stream.pipe(writeStream);
      stream.on('error', reject);
      writeStream.on('error', reject);
      writeStream.on('finish', () => resolve());
    });

    logger.info(`Downloaded ${key} to ${tmpFile}`);
    return tmpFile;
  }

  private createLoader(type: string, filePath: string) {
    switch (type) {
      case 'pdf':
        return new PDFLoader(filePath);
      case 'csv':
        return new CSVLoader(filePath);
      case 'json':
        return new JSONLoader(filePath);
      case 'text':
      case 'markdown':
      default:
        return new TextLoader(filePath);
    }
  }
}
