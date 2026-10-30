use aws_sdk_s3::primitives::ByteStream;
use crate::common;

#[tokio::test]
async fn separate_s3_keys_cannot_read_write_list_delete_or_copy_each_others_bucket() {
	let a = common::context();
	let b = common::context();
	let bucket_a = a.create_bucket("tenant-a");
	let bucket_b = b.create_bucket("tenant-b");
	for (ctx, bucket) in [(&a, &bucket_a), (&b, &bucket_b)] {
		ctx.client.put_object().bucket(bucket).key("private")
			.body(ByteStream::from_static(b"private data")).send().await.unwrap();
	}
	for (ctx, own, other) in [(&a, &bucket_a, &bucket_b), (&b, &bucket_b, &bucket_a)] {
		let buckets = ctx.client.list_buckets().send().await.unwrap();
		let names: Vec<_> = buckets.buckets().iter().filter_map(|bucket| bucket.name()).collect();
		assert!(names.contains(&own.as_str()));
		assert!(!names.contains(&other.as_str()));
		assert!(ctx.client.list_objects_v2().bucket(other).send().await.is_err());
		assert!(ctx.client.get_object().bucket(other).key("private").send().await.is_err());
		assert!(ctx.client.head_object().bucket(other).key("private").send().await.is_err());
		assert!(ctx.client.put_object().bucket(other).key("intrusion")
			.body(ByteStream::from_static(b"intrusion")).send().await.is_err());
		assert!(ctx.client.delete_object().bucket(other).key("private").send().await.is_err());
		assert!(ctx.client.copy_object().bucket(own).key("copy")
			.copy_source(format!("{other}/private")).send().await.is_err());
		assert!(ctx.client.get_object().bucket(own).key("private").send().await.is_ok());
	}
}
