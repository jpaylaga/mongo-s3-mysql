import { z } from 'zod';

/** A MySQL identifier as the mapping and the infer flags accept it. */
const identifierSchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/, 'letters, digits, underscore; max 64');

export default identifierSchema;
