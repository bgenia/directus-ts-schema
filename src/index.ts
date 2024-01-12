#!/usr/bin/env node

import { Snapshot, SnapshotField } from "@directus/api/types/snapshot"
import { binary, command, flag, option, positional, run, string } from "cmd-ts"
import FS from "node:fs/promises"
import Path from "node:path"
import TS from "typescript"
import YAML from "yaml"

async function loadSchema(schemaFile: string) {
	const content = await FS.readFile(schemaFile, "utf-8")

	if (Path.extname(schemaFile) === ".json") {
		return JSON.parse(content) as Snapshot
	}

	if (Path.extname(schemaFile) === ".yaml") {
		return YAML.parse(content) as Snapshot
	}

	throw new Error(`Invalid schema file extension: ${schemaFile}`)
}

function convertSnakeToPascalCase(string: string) {
	return string
		.split("_")
		.map((word) => word[0]!.toUpperCase() + word.slice(1))
		.join("")
}

export function getFieldType(field: SnapshotField): TS.TypeNode {
	let result: TS.TypeNode

	switch (field.type) {
		case "boolean":
			result = TS.factory.createKeywordTypeNode(TS.SyntaxKind.BooleanKeyword)
			break
		case "date":
		case "dateTime":
		case "time":
		case "timestamp":
			result = TS.factory.createTypeReferenceNode("Date")
			break
		case "decimal":
		case "float":
		case "integer":
		case "bigInteger":
			result = TS.factory.createKeywordTypeNode(TS.SyntaxKind.NumberKeyword)
			break
		case "hash":
		case "string":
		case "text":
		case "uuid":
			result = TS.factory.createKeywordTypeNode(TS.SyntaxKind.StringKeyword)
			break
		case "unknown":
		case "csv":
		case "json":
		case "alias":
			result = TS.factory.createKeywordTypeNode(TS.SyntaxKind.UnknownKeyword)
			break
		case "geometry":
		case "geometry.LineString":
		case "geometry.MultiLineString":
		case "geometry.MultiPoint":
		case "geometry.MultiPolygon":
		case "geometry.Point":
		case "geometry.Polygon":
		case "binary":
		default:
			throw new Error(`Unsupported field type: ${field.type}`)
	}

	if (field.schema?.is_nullable) {
		result = TS.factory.createUnionTypeNode([
			result,
			TS.factory.createLiteralTypeNode(TS.factory.createNull()),
		])
	}

	return result
}

const cli = command({
	name: "directus-ts-schema",
	description: "Generates TypeScript types from Directus schema",
	args: {
		schemaFile: positional({
			description: "Path to Directus schema file (JSON or YAML)",
			displayName: "schema-file",
			type: string,
		}),
		outFile: option({
			long: "out-file",
			short: "o",
			description: "Path to output file",
			type: string,
			defaultValue: () => "schema.ts",
		}),
		useNamespace: flag({
			long: "use-namespace",
			short: "n",
			description: "Put collection types in a namespace",
			defaultValue: () => false,
		}),
	},
	async handler(argv) {
		const { schemaFile, outFile, useNamespace } = argv

		const schema = await loadSchema(schemaFile)

		const collectionTypeDeclarations = new Map<
			string,
			TS.TypeAliasDeclaration
		>()

		for (const collection of schema.collections) {
			const fields = schema.fields.filter(
				(field) => field.collection === collection.collection,
			)

			const properties: TS.PropertySignature[] = []

			for (const field of fields) {
				const type = getFieldType(field)

				const property = TS.factory.createPropertySignature(
					[],
					field.field,
					undefined,
					type,
				)

				properties.push(property)
			}

			const typeName = convertSnakeToPascalCase(collection.collection)

			const declaration = TS.factory.createTypeAliasDeclaration(
				[TS.factory.createToken(TS.SyntaxKind.ExportKeyword)],
				typeName,
				[],
				TS.factory.createTypeLiteralNode(properties),
			)

			collectionTypeDeclarations.set(collection.collection, declaration)
		}

		const schemaDeclaration = TS.factory.createTypeAliasDeclaration(
			[TS.factory.createToken(TS.SyntaxKind.ExportKeyword)],
			"Schema",
			[],
			TS.factory.createTypeLiteralNode(
				[...collectionTypeDeclarations.keys()].map((collection) =>
					TS.factory.createPropertySignature(
						[],
						collection,
						undefined,
						TS.factory.createTypeReferenceNode(
							convertSnakeToPascalCase(collection),
						),
					),
				),
			),
		)

		const schemaNamespace = TS.factory.createModuleDeclaration(
			[TS.factory.createToken(TS.SyntaxKind.ExportKeyword)],
			TS.factory.createIdentifier("Schema"),
			TS.factory.createModuleBlock([...collectionTypeDeclarations.values()]),
			TS.NodeFlags.Namespace,
		)

		const schemaNamespaceOrDeclaration = useNamespace
			? [schemaNamespace]
			: collectionTypeDeclarations.values()

		const sourceFile = TS.factory.createSourceFile(
			[...schemaNamespaceOrDeclaration, schemaDeclaration],
			TS.factory.createToken(TS.SyntaxKind.EndOfFileToken),
			TS.NodeFlags.None,
		)

		const printer = TS.createPrinter()

		const output = printer.printFile(sourceFile)

		await FS.writeFile(outFile, output)
	},
})

run(binary(cli), process.argv)
