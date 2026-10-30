use aws_sdk_s3::primitives::ByteStream;
use aws_sdk_s3::types::ServerSideEncryption;

use crate::common;

#[tokio::test]
async fn unsupported_server_encryption_never_creates_plaintext_objects() {
	let ctx = common::context();
	let bucket = ctx.create_bucket("unsupported-encryption");

	let result = ctx
		.client
		.put_object()
		.bucket(&bucket)
		.key("object")
		.server_side_encryption(ServerSideEncryption::Aes256)
		.body(ByteStream::from_static(b"secret"))
		.send()
		.await;
	assert!(result.is_err());
	assert!(ctx.client.head_object().bucket(&bucket).key("object").send().await.is_err());

	let result = ctx
		.client
		.create_multipart_upload()
		.bucket(&bucket)
		.key("multipart")
		.server_side_encryption(ServerSideEncryption::AwsKms)
		.send()
		.await;
	assert!(result.is_err());
}

#[tokio::test]
async fn unsupported_lock_and_storage_class_are_not_silently_accepted() {
	use aws_sdk_s3::types::{ObjectLockMode, StorageClass};

	let ctx = common::context();
	let bucket = ctx.create_bucket("unsupported-options");
	let result = ctx.client.put_object().bucket(&bucket).key("archived")
		.storage_class(StorageClass::Glacier)
		.body(ByteStream::from_static(b"data"))
		.send().await;
	assert!(result.is_err());
	let result = ctx.client.put_object().bucket(&bucket).key("locked")
		.object_lock_mode(ObjectLockMode::Compliance)
		.body(ByteStream::from_static(b"data"))
		.send().await;
	assert!(result.is_err());
	for key in ["archived", "locked"] {
		assert!(ctx.client.head_object().bucket(&bucket).key(key).send().await.is_err());
	}
	ctx.client.put_object().bucket(&bucket).key("standard")
		.storage_class(StorageClass::Standard)
		.body(ByteStream::from_static(b"data"))
		.send().await.unwrap();
}
