project_id  = "dryscope"
region      = "us-central1"
environment = "test"

# Shared-core db-f1-micro (ENTERPRISE edition, zonal): about $10/month; no uptime guarantee, fine for test.
sql_tier                  = "db-f1-micro"
sql_disk_size_gb          = 10
sql_backup_retained_count = 7
sql_pitr_log_days         = 3

evidence_soft_delete_days = 7
